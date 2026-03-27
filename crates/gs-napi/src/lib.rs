use std::collections::BTreeSet;
use std::hash::{Hash, Hasher};
use std::sync::Arc;
use std::time::Instant;

use base64::Engine;
use gs_execute::SessionState;
use gs_execute::plugins::PluginRegistration;
use gs_extract::actions::ActionDeriver;
use gs_transport::cdp::CdpTransport;
use gs_transport::BrowserTransport;
use gs_types::*;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

/// Configuration passed from TypeScript to create a session.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionConfig {
    /// Chrome CDP WebSocket URL (e.g. ws://127.0.0.1:9222/devtools/page/...)
    ws_url: String,
    /// Initial URL to navigate to
    url: Option<String>,
    /// Whether to wait for DOM stability after navigation (default: true)
    #[serde(default = "default_true")]
    wait_for_stable: bool,
}

fn default_true() -> bool {
    true
}

/// Query request from TypeScript.
#[derive(Debug, Deserialize)]
struct QueryRequest {
    entity: String,
    #[serde(rename = "where")]
    where_clause: Option<serde_json::Value>,
    limit: Option<usize>,
}

/// Entity DTO sent back to TypeScript.
#[derive(Debug, Serialize)]
struct EntityDto {
    id: String,
    #[serde(rename = "_ref")]
    interactive_ref: String,
    #[serde(rename = "_entity")]
    entity_type: String,
    #[serde(rename = "_source")]
    source: String,
    #[serde(rename = "_confidence")]
    confidence: f64,
    #[serde(flatten)]
    properties: serde_json::Value,
}

/// Action DTO sent back to TypeScript.
#[derive(Debug, Serialize)]
struct ActionDto {
    id: String,
    name: String,
    #[serde(rename = "type")]
    action_type: String,
    targets: Vec<String>,
    target_ref: serde_json::Value,
    preconditions: Vec<ConditionDto>,
    postconditions: Vec<ConditionDto>,
    confidence: f64,
}

#[derive(Debug, Serialize)]
struct ConditionDto {
    description: String,
    check: serde_json::Value,
}

/// The main napi-rs class exposed to Node.js.
///
/// Wraps the Rust session state and CDP transport,
/// serializing all complex data as JSON strings across the FFI boundary.
#[napi]
pub struct NativeSession {
    state: Arc<Mutex<SessionState>>,
    transport: Arc<Mutex<CdpTransport>>,
}

#[napi]
impl NativeSession {
    /// Create and connect a new session.
    #[napi(factory)]
    pub async fn create(config_json: String) -> Result<Self> {
        let config: SessionConfig = serde_json::from_str(&config_json)
            .map_err(|e| Error::from_reason(format!("invalid config: {e}")))?;

        let session_id = uuid::Uuid::new_v4().to_string();
        let mut transport = CdpTransport::new(&config.ws_url);

        transport
            .connect()
            .await
            .map_err(|e| Error::from_reason(format!("connection failed: {e}")))?;

        let mut state = SessionState::new(&session_id);

        // Navigate if URL provided
        if let Some(url) = &config.url {
            transport
                .navigate(url)
                .await
                .map_err(|e| Error::from_reason(format!("navigation failed: {e}")))?;

            state.tracer.record_navigation(url.as_str(), Some(200));

            if config.wait_for_stable {
                let _ = state.observer.wait_for_stable(&transport, 10000).await;
            }

            // Initial observation and extraction
            if let Ok(observation) = state.observer.observe(&mut transport).await {
                let before_keys = snapshot_key_set(&state);
                let ids = state
                    .pipeline
                    .extract_and_upsert(&observation, &mut state.graph);
                state
                    .tracer
                    .record_extraction("initial", ids.len(), 0);
                record_graph_snapshot(&state, "initial", &observation.url, &before_keys);
            }
        }

        Ok(Self {
            state: Arc::new(Mutex::new(state)),
            transport: Arc::new(Mutex::new(transport)),
        })
    }

    /// Query entities from the state graph.
    #[napi]
    pub async fn query(&self, query_json: String) -> Result<String> {
        let request: QueryRequest = serde_json::from_str(&query_json)
            .map_err(|e| Error::from_reason(format!("invalid query: {e}")))?;

        let state = self.state.lock().await;
        let kind = string_to_entity_kind(&request.entity);

        let entities = state.graph.query(&kind, None);

        // Apply where clause filter if present
        let filtered: Vec<_> = if let Some(where_clause) = &request.where_clause {
            entities
                .into_iter()
                .filter(|e| matches_where_clause(e, where_clause))
                .collect()
        } else {
            entities
        };

        // Apply limit
        let limited: Vec<_> = if let Some(limit) = request.limit {
            filtered.into_iter().take(limit).collect()
        } else {
            filtered
        };

        let dtos: Vec<EntityDto> = limited
            .iter()
            .map(|e| EntityDto {
                id: e.session_entity_id.clone(),
                interactive_ref: interactive_ref_for_entity(e),
                entity_type: request.entity.clone(),
                source: e.source.selector.clone(),
                confidence: e.confidence,
                properties: e.properties.clone(),
            })
            .collect();

        let result_count = dtos.len();
        let json = serde_json::to_string(&dtos)
            .map_err(|e| Error::from_reason(format!("serialization error: {e}")))?;

        state.tracer.record_query(
            &request.entity,
            request.where_clause.clone(),
            result_count,
            0,
        );

        Ok(json)
    }

    /// Get available actions for a set of entity IDs.
    #[napi]
    pub async fn actions_for(&self, entity_refs_json: String) -> Result<String> {
        let entity_ids_str: Vec<String> = serde_json::from_str(&entity_refs_json)
            .map_err(|e| Error::from_reason(format!("invalid entity refs: {e}")))?;

        let state = self.state.lock().await;

        // Resolve string IDs to EntityIds
        let entity_ids: Vec<EntityId> = state
            .graph
            .all_entities()
            .iter()
            .filter(|e| entity_ids_str.contains(&e.session_entity_id))
            .map(|e| e.id)
            .collect();

        let mut actions = ActionDeriver::derive_actions_for_ids(&entity_ids, &state.graph);
        actions.extend(state.plugins.derive_actions_for_ids(&entity_ids, &state.graph));

        let dtos: Vec<ActionDto> = actions
            .iter()
            .map(|a| ActionDto {
                id: a.id.0.clone(),
                name: a.name.clone(),
                action_type: format!("{:?}", a.action_type).to_lowercase(),
                targets: a
                    .targets
                    .iter()
                    .map(|t| {
                        state
                            .graph
                            .get(*t)
                            .map(|e| e.session_entity_id.clone())
                            .unwrap_or_default()
                    })
                    .collect(),
                target_ref: serde_json::to_value(&a.target_ref).unwrap_or_default(),
                preconditions: a
                    .preconditions
                    .iter()
                    .map(|c| ConditionDto {
                        description: c.description.clone(),
                        check: serde_json::to_value(&c.check).unwrap_or_default(),
                    })
                    .collect(),
                postconditions: a
                    .postconditions
                    .iter()
                    .map(|c| ConditionDto {
                        description: c.description.clone(),
                        check: serde_json::to_value(&c.check).unwrap_or_default(),
                    })
                    .collect(),
                confidence: a.confidence,
            })
            .collect();

        serde_json::to_string(&dtos)
            .map_err(|e| Error::from_reason(format!("serialization error: {e}")))
    }

    /// Execute a single action step.
    ///
    /// The incoming JSON uses UUID strings for entity references (targets,
    /// condition entity_ids) because that's what the TypeScript SDK sees.
    /// We map them back to internal `EntityId(u32)` before dispatching.
    #[napi]
    pub async fn execute(&self, step_json: String) -> Result<String> {
        let mut value: serde_json::Value = serde_json::from_str(&step_json)
            .map_err(|e| Error::from_reason(format!("invalid step JSON: {e}")))?;

        {
            let state = self.state.lock().await;
            remap_step_ids(&mut value, &state);
        }

        let step: ExecutionStep = serde_json::from_value(value)
            .map_err(|e| Error::from_reason(format!("invalid step: {e}")))?;

        let mut state = self.state.lock().await;
        let mut transport = self.transport.lock().await;

        let mut result = gs_execute::execute_action(
            &step.action,
            &step,
            &mut state,
            &mut *transport,
        )
        .await;

        if result.status == ExecutionStatus::Failed {
            let plugins = state.plugins.clone();
            if let Some(recovered) = plugins
                .try_recover(&step, &mut state, &mut *transport, &result)
                .await
            {
                result = recovered;
            }
        }

        serde_json::to_string(&result)
            .map_err(|e| Error::from_reason(format!("serialization error: {e}")))
    }

    /// Register a native plugin with the current session.
    #[napi]
    pub async fn register_plugin(&self, plugin_json: String) -> Result<()> {
        let plugin: PluginRegistration = serde_json::from_str(&plugin_json)
            .map_err(|e| Error::from_reason(format!("invalid plugin: {e}")))?;
        let mut state = self.state.lock().await;
        state.plugins.register(plugin);
        Ok(())
    }

    /// List registered native plugins.
    #[napi]
    pub async fn list_plugins(&self) -> Result<String> {
        let state = self.state.lock().await;
        serde_json::to_string(&state.plugins.list())
            .map_err(|e| Error::from_reason(format!("serialization error: {e}")))
    }

    /// Get the full execution trace.
    #[napi]
    pub async fn get_trace(&self) -> Result<String> {
        let state = self.state.lock().await;
        Ok(state.tracer.to_json())
    }

    /// Get trace events after the given sequence number.
    #[napi]
    pub async fn get_trace_since(&self, since_seq: u32) -> Result<String> {
        let state = self.state.lock().await;
        let events = state.tracer.events_since(u64::from(since_seq));
        serde_json::to_string(&events)
            .map_err(|e| Error::from_reason(format!("serialization error: {e}")))
    }

    /// Force a fresh browser observation and graph update.
    #[napi]
    pub async fn refresh(&self) -> Result<String> {
        let start = Instant::now();
        let mut state = self.state.lock().await;
        let mut transport = self.transport.lock().await;
        let before_keys = snapshot_key_set(&state);

        let observation = state
            .observer
            .observe(&mut *transport)
            .await
            .map_err(|e| Error::from_reason(format!("refresh failed: {e}")))?;

        let pipeline = std::mem::take(&mut state.pipeline);
        let ids = pipeline.extract_and_upsert(&observation, &mut state.graph);
        state.pipeline = pipeline;
        let duration_ms = start.elapsed().as_millis() as u64;

        state.tracer.record_observation(
            &observation.url,
            ids.len(),
            duration_ms,
        );
        state.tracer.record_extraction("refresh", ids.len(), duration_ms);
        record_graph_snapshot(&state, "refresh", &observation.url, &before_keys);

        let entities: Vec<EntityDto> = state
            .graph
            .all_entities()
            .iter()
            .map(|e| EntityDto {
                id: e.session_entity_id.clone(),
                interactive_ref: interactive_ref_for_entity(e),
                entity_type: entity_kind_to_string(&e.kind),
                source: e.source.selector.clone(),
                confidence: e.confidence,
                properties: e.properties.clone(),
            })
            .collect();

        serde_json::to_string(&entities)
            .map_err(|e| Error::from_reason(format!("serialization error: {e}")))
    }

    /// Evaluate arbitrary JavaScript in the page context.
    #[napi]
    pub async fn evaluate_js(&self, script: String) -> Result<String> {
        let mut transport = self.transport.lock().await;
        let value = transport
            .evaluate_js(&script)
            .await
            .map_err(|e| Error::from_reason(format!("evaluate_js failed: {e}")))?;
        serde_json::to_string(&value)
            .map_err(|e| Error::from_reason(format!("serialization error: {e}")))
    }

    /// Capture a screenshot of the current page and return it as base64 PNG.
    #[napi]
    pub async fn screenshot(&self) -> Result<String> {
        let mut transport = self.transport.lock().await;
        let bytes = transport
            .screenshot()
            .await
            .map_err(|e| Error::from_reason(format!("screenshot failed: {e}")))?;
        Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
    }

    /// Return the current page URL.
    #[napi]
    pub async fn current_url(&self) -> Result<String> {
        let transport = self.transport.lock().await;
        transport
            .current_url()
            .await
            .map_err(|e| Error::from_reason(format!("current_url failed: {e}")))
    }

    /// Raw selector click escape hatch.
    #[napi]
    pub async fn click_selector(&self, selector: String) -> Result<()> {
        let mut transport = self.transport.lock().await;
        transport
            .click(&TargetRef::Selector { selector })
            .await
            .map_err(|e| Error::from_reason(format!("click_selector failed: {e}")))
    }

    /// Raw selector typing escape hatch.
    #[napi]
    pub async fn type_into_selector(&self, selector: String, text: String) -> Result<()> {
        let mut transport = self.transport.lock().await;
        transport
            .type_text(&TargetRef::Selector { selector }, &text)
            .await
            .map_err(|e| Error::from_reason(format!("type_into_selector failed: {e}")))
    }

    /// Close the session and disconnect from the browser.
    #[napi]
    pub async fn close(&self) -> Result<()> {
        let mut transport = self.transport.lock().await;
        transport
            .disconnect()
            .await
            .map_err(|e| Error::from_reason(format!("disconnect failed: {e}")))?;
        Ok(())
    }
}

/// Map a string entity type name to an EntityKind.
fn string_to_entity_kind(s: &str) -> EntityKind {
    match s.to_lowercase().as_str() {
        "table" => EntityKind::Table,
        "tablerow" | "table_row" => EntityKind::TableRow,
        "form" => EntityKind::Form,
        "formfield" | "form_field" => EntityKind::FormField,
        "button" => EntityKind::Button,
        "link" => EntityKind::Link,
        "modal" => EntityKind::Modal,
        "dialog" => EntityKind::Dialog,
        "menu" => EntityKind::Menu,
        "tab" => EntityKind::Tab,
        "list" => EntityKind::List,
        "listitem" | "list_item" => EntityKind::ListItem,
        "searchresult" | "search_result" => EntityKind::SearchResult,
        "pagination" => EntityKind::Pagination,
        _ => EntityKind::Custom(s.to_string()),
    }
}

fn entity_kind_to_string(kind: &EntityKind) -> String {
    match kind {
        EntityKind::Table => "Table".into(),
        EntityKind::TableRow => "TableRow".into(),
        EntityKind::Form => "Form".into(),
        EntityKind::FormField => "FormField".into(),
        EntityKind::Button => "Button".into(),
        EntityKind::Link => "Link".into(),
        EntityKind::Modal => "Modal".into(),
        EntityKind::Dialog => "Dialog".into(),
        EntityKind::Menu => "Menu".into(),
        EntityKind::Tab => "Tab".into(),
        EntityKind::List => "List".into(),
        EntityKind::ListItem => "ListItem".into(),
        EntityKind::SearchResult => "SearchResult".into(),
        EntityKind::Pagination => "Pagination".into(),
        EntityKind::Custom(value) => value.clone(),
    }
}

fn interactive_ref_for_entity(entity: &SemanticEntity) -> String {
    format!("@e:{}", entity.session_entity_id)
}

fn snapshot_key_set(state: &SessionState) -> BTreeSet<String> {
    state
        .graph
        .all_entities()
        .iter()
        .map(|entity| format!("{:?}::{}", entity.kind, entity.stable_key.fingerprint))
        .collect()
}

fn snapshot_hash(state: &SessionState) -> String {
    let mut entities: Vec<String> = state
        .graph
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
    let after_keys = snapshot_key_set(state);
    let added_count = after_keys.difference(before_keys).count();
    let removed_count = before_keys.difference(&after_keys).count();
    let snapshot_hash = snapshot_hash(state);
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

/// Check if an entity matches a where clause (simple equality + comparison operators).
fn matches_where_clause(entity: &SemanticEntity, where_clause: &serde_json::Value) -> bool {
    let clause = match where_clause.as_object() {
        Some(obj) => obj,
        None => return true,
    };

    for (field, expected) in clause {
        let actual = entity.properties.get(field);

        match expected {
            // Direct equality: { "status": "Unpaid" }
            serde_json::Value::String(_)
            | serde_json::Value::Number(_)
            | serde_json::Value::Bool(_) => {
                if actual != Some(expected) {
                    return false;
                }
            }
            // Comparison operators: { "amount": { "gt": 10000 } }
            serde_json::Value::Object(ops) => {
                let actual_val = match actual {
                    Some(v) => v,
                    None => return false,
                };

                for (op, cmp_val) in ops {
                    let result = match op.as_str() {
                        "eq" => actual_val == cmp_val,
                        "neq" => actual_val != cmp_val,
                        "gt" => compare_values(actual_val, cmp_val) == Some(std::cmp::Ordering::Greater),
                        "gte" => compare_values(actual_val, cmp_val).is_some_and(|o| o != std::cmp::Ordering::Less),
                        "lt" => compare_values(actual_val, cmp_val) == Some(std::cmp::Ordering::Less),
                        "lte" => compare_values(actual_val, cmp_val).is_some_and(|o| o != std::cmp::Ordering::Greater),
                        "in" => cmp_val
                            .as_array()
                            .is_some_and(|arr| arr.contains(actual_val)),
                        "contains" => {
                            actual_val.as_str().is_some_and(|a| {
                                cmp_val.as_str().is_some_and(|c| a.contains(c))
                            })
                        }
                        _ => true,
                    };
                    if !result {
                        return false;
                    }
                }
            }
            _ => {}
        }
    }

    true
}

/// Remap UUID string IDs in the incoming step JSON back to internal EntityId(u32).
///
/// The TypeScript SDK sees UUID session_entity_ids, but the Rust types use
/// EntityId(u32) petgraph node indices. This function walks the step JSON and
/// replaces any UUID string that matches a known entity with its internal u32 ID.
fn remap_step_ids(value: &mut serde_json::Value, state: &SessionState) {
    // Build a UUID→u32 lookup.
    let id_map: std::collections::HashMap<String, u32> = state
        .graph
        .all_entities()
        .iter()
        .map(|e| (e.session_entity_id.clone(), e.id.0))
        .collect();

    remap_value(value, &id_map);
}

fn remap_value(value: &mut serde_json::Value, id_map: &std::collections::HashMap<String, u32>) {
    match value {
        serde_json::Value::Object(map) => {
            // Remap "targets" array: UUID strings → u32
            if let Some(targets) = map.get_mut("targets")
                && let Some(arr) = targets.as_array_mut()
            {
                for item in arr.iter_mut() {
                    if let Some(uuid) = item.as_str()
                        && let Some(&internal_id) = id_map.get(uuid)
                    {
                        *item = serde_json::Value::Number(internal_id.into());
                    }
                }
            }
            // Remap "entity_id" field in condition checks: UUID string → u32
            if let Some(entity_id) = map.get_mut("entity_id")
                && let Some(uuid) = entity_id.as_str()
                && let Some(&internal_id) = id_map.get(uuid)
            {
                *entity_id = serde_json::Value::Number(internal_id.into());
            }
            // Remap "type" → "action_type" (TS DTO uses "type", Rust struct uses "action_type")
            if map.contains_key("type") && !map.contains_key("action_type") && map.contains_key("targets")
                && let Some(type_val) = map.remove("type")
            {
                map.insert("action_type".to_string(), type_val);
            }
            // Inject a default target_ref if missing
            if map.contains_key("action_type") && !map.contains_key("target_ref") {
                map.insert(
                    "target_ref".to_string(),
                    serde_json::json!({ "type": "selector", "selector": "body" }),
                );
            }
            // Recurse into all values
            for (_, v) in map.iter_mut() {
                remap_value(v, id_map);
            }
        }
        serde_json::Value::Array(arr) => {
            for item in arr.iter_mut() {
                remap_value(item, id_map);
            }
        }
        _ => {}
    }
}

fn compare_values(a: &serde_json::Value, b: &serde_json::Value) -> Option<std::cmp::Ordering> {
    // Try numeric comparison first
    if let (Some(a_num), Some(b_num)) = (a.as_f64(), b.as_f64()) {
        return a_num.partial_cmp(&b_num);
    }
    // Try string comparison (also handles numeric strings)
    if let (Some(a_str), Some(b_str)) = (a.as_str(), b.as_str()) {
        // Try parsing as numbers
        if let (Ok(a_num), Ok(b_num)) = (a_str.parse::<f64>(), b_str.parse::<f64>()) {
            return a_num.partial_cmp(&b_num);
        }
        return Some(a_str.cmp(b_str));
    }
    None
}
