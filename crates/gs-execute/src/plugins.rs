use gs_graph::StateGraph;
use gs_transport::BrowserTransport;
use gs_types::*;
use serde::{Deserialize, Serialize};

use crate::{execute_action, SessionState};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PluginRegistration {
    Action(ActionPluginSpec),
    Recovery(RecoveryPluginSpec),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionPluginSpec {
    pub name: String,
    pub entity_kind: String,
    pub action_type: ActionType,
    pub selector_override: Option<String>,
    pub confidence: f64,
    pub params: Option<serde_json::Value>,
    #[serde(default)]
    pub preconditions: Vec<Condition>,
    #[serde(default)]
    pub postconditions: Vec<Condition>,
    pub field_match: Option<FieldMatch>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FieldMatch {
    pub field: String,
    pub equals: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecoveryPluginSpec {
    pub name: String,
    #[serde(default)]
    pub match_error_codes: Vec<String>,
    #[serde(default)]
    pub operations: Vec<RecoveryOperation>,
    #[serde(default)]
    pub retry_original: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RecoveryOperation {
    ClickSelector { selector: String },
    TypeIntoSelector { selector: String, text: String },
    EvaluateJs { script: String },
    Refresh,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PluginRegistry {
    pub actions: Vec<ActionPluginSpec>,
    pub recoveries: Vec<RecoveryPluginSpec>,
}

impl PluginRegistry {
    pub fn register(&mut self, registration: PluginRegistration) {
        match registration {
            PluginRegistration::Action(action) => self.actions.push(action),
            PluginRegistration::Recovery(recovery) => self.recoveries.push(recovery),
        }
    }

    pub fn list(&self) -> Vec<PluginRegistration> {
        let mut out = Vec::new();
        out.extend(self.actions.iter().cloned().map(PluginRegistration::Action));
        out.extend(
            self.recoveries
                .iter()
                .cloned()
                .map(PluginRegistration::Recovery),
        );
        out
    }

    pub fn derive_actions_for_ids(
        &self,
        entity_ids: &[EntityId],
        graph: &StateGraph,
    ) -> Vec<Action> {
        entity_ids
            .iter()
            .filter_map(|id| graph.get(*id))
            .flat_map(|entity| {
                self.actions
                    .iter()
                    .filter(move |spec| matches_entity(spec, entity))
                    .map(move |spec| Action {
                        id: ActionId::new(),
                        name: spec.name.clone(),
                        action_type: spec.action_type.clone(),
                        targets: vec![entity.id],
                        target_ref: TargetRef::Selector {
                            selector: spec
                                .selector_override
                                .clone()
                                .unwrap_or_else(|| entity.source.selector.clone()),
                        },
                        preconditions: spec.preconditions.clone(),
                        postconditions: spec.postconditions.clone(),
                        confidence: spec.confidence,
                        params: spec.params.clone(),
                    })
            })
            .collect()
    }

    pub async fn try_recover(
        &self,
        step: &ExecutionStep,
        state: &mut SessionState,
        transport: &mut dyn BrowserTransport,
        result: &ExecutionResult,
    ) -> Option<ExecutionResult> {
        let error_code = result.error.as_ref()?.code.clone();
        let recovery = self.recoveries.iter().find(|spec| {
            spec.match_error_codes.is_empty() || spec.match_error_codes.contains(&error_code)
        })?;

        for operation in &recovery.operations {
            match operation {
                RecoveryOperation::ClickSelector { selector } => {
                    if transport
                        .click(&TargetRef::Selector {
                            selector: selector.clone(),
                        })
                        .await
                        .is_err()
                    {
                        return None;
                    }
                }
                RecoveryOperation::TypeIntoSelector { selector, text } => {
                    if transport
                        .type_text(
                            &TargetRef::Selector {
                                selector: selector.clone(),
                            },
                            text,
                        )
                        .await
                        .is_err()
                    {
                        return None;
                    }
                }
                RecoveryOperation::EvaluateJs { script } => {
                    if transport.evaluate_js(script).await.is_err() {
                        return None;
                    }
                }
                RecoveryOperation::Refresh => {
                    if state.observer.observe(transport).await.is_err() {
                        return None;
                    }
                }
            }
        }

        if recovery.retry_original {
            return Some(execute_action(&step.action, step, state, transport).await);
        }

        None
    }
}

fn matches_entity(spec: &ActionPluginSpec, entity: &SemanticEntity) -> bool {
    if entity_kind_name(&entity.kind) != spec.entity_kind.to_lowercase() {
        return false;
    }

    match &spec.field_match {
        Some(field_match) => entity.properties.get(&field_match.field) == Some(&field_match.equals),
        None => true,
    }
}

fn entity_kind_name(kind: &EntityKind) -> String {
    match kind {
        EntityKind::Table => "table".into(),
        EntityKind::TableRow => "tablerow".into(),
        EntityKind::Form => "form".into(),
        EntityKind::FormField => "formfield".into(),
        EntityKind::Button => "button".into(),
        EntityKind::Link => "link".into(),
        EntityKind::Modal => "modal".into(),
        EntityKind::Dialog => "dialog".into(),
        EntityKind::Menu => "menu".into(),
        EntityKind::Tab => "tab".into(),
        EntityKind::List => "list".into(),
        EntityKind::ListItem => "listitem".into(),
        EntityKind::SearchResult => "searchresult".into(),
        EntityKind::Pagination => "pagination".into(),
        EntityKind::Custom(value) => value.to_lowercase(),
    }
}
