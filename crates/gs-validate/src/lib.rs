#[cfg(test)]
mod validation_tests;

use gs_graph::StateGraph;
use gs_types::*;

/// Evaluate an action's preconditions against the current graph state.
/// Returns results for each condition.
pub fn validate_preconditions(action: &Action, graph: &StateGraph) -> Vec<ConditionResult> {
    action
        .preconditions
        .iter()
        .map(|cond| evaluate_condition(cond, graph))
        .collect()
}

/// Evaluate an action's postconditions against the current graph state.
/// Typically called after re-observation following action execution.
pub fn validate_postconditions(action: &Action, graph: &StateGraph) -> Vec<ConditionResult> {
    action
        .postconditions
        .iter()
        .map(|cond| evaluate_condition(cond, graph))
        .collect()
}

/// Check whether all preconditions pass.
pub fn all_preconditions_met(action: &Action, graph: &StateGraph) -> bool {
    validate_preconditions(action, graph)
        .iter()
        .all(|r| r.passed)
}

fn evaluate_condition(condition: &Condition, graph: &StateGraph) -> ConditionResult {
    match &condition.check {
        ConditionCheck::EntityState {
            entity_id,
            field,
            expected,
        } => {
            let actual = graph
                .get(*entity_id)
                .and_then(|e| e.properties.get(field))
                .cloned();

            let passed = actual.as_ref() == Some(expected);
            let message = if passed {
                None
            } else {
                Some(format!("expected {field} = {expected}, got {actual:?}",))
            };

            ConditionResult {
                condition: condition.clone(),
                passed,
                actual,
                message,
            }
        }

        // For DOM-level checks (ElementVisible, ElementAbsent, TextMatches, UrlMatches),
        // we cannot evaluate them purely from the graph — they require the transport.
        // At the validation layer, we check what we can. The execution engine handles
        // transport-level postcondition checks via JS evaluation.
        ConditionCheck::ElementVisible { selector } => ConditionResult {
            condition: condition.clone(),
            passed: true, // Deferred to transport-level check
            actual: Some(serde_json::Value::String(selector.clone())),
            message: Some("deferred to transport".into()),
        },

        ConditionCheck::ElementAbsent { selector } => ConditionResult {
            condition: condition.clone(),
            passed: true, // Deferred to transport-level check
            actual: Some(serde_json::Value::String(selector.clone())),
            message: Some("deferred to transport".into()),
        },

        ConditionCheck::TextMatches { selector, pattern } => ConditionResult {
            condition: condition.clone(),
            passed: true, // Deferred
            actual: Some(serde_json::json!({"selector": selector, "pattern": pattern})),
            message: Some("deferred to transport".into()),
        },

        ConditionCheck::UrlMatches { pattern } => ConditionResult {
            condition: condition.clone(),
            passed: true, // Deferred
            actual: Some(serde_json::Value::String(pattern.clone())),
            message: Some("deferred to transport".into()),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn setup_graph_with_table() -> (StateGraph, EntityId) {
        let mut graph = StateGraph::new();
        let entity = SemanticEntity::new(
            EntityId(0),
            StableKey::new(EntityKind::Table, "invoices"),
            EntityKind::Table,
            json!({"sorted_by": "Name", "row_count": 5}),
            SourceRef {
                selector: "#invoices".into(),
                backend_node_id: Some(100),
                a11y_id: None,
            },
            0.9,
        );
        let id = graph.upsert(entity);
        (graph, id)
    }

    #[test]
    fn entity_state_condition_passes_when_matching() {
        let (graph, id) = setup_graph_with_table();

        let action = Action {
            id: ActionId::new(),
            name: "Sort by Name".into(),
            action_type: ActionType::Click,
            targets: vec![id],
            target_ref: TargetRef::Selector {
                selector: "#invoices th:nth-child(1)".into(),
            },
            preconditions: vec![],
            postconditions: vec![Condition {
                description: "Table is sorted by Name".into(),
                check: ConditionCheck::EntityState {
                    entity_id: id,
                    field: "sorted_by".into(),
                    expected: json!("Name"),
                },
            }],
            confidence: 0.7,
            params: None,
        };

        let results = validate_postconditions(&action, &graph);
        assert_eq!(results.len(), 1);
        assert!(results[0].passed);
    }

    #[test]
    fn entity_state_condition_fails_when_mismatched() {
        let (graph, id) = setup_graph_with_table();

        let action = Action {
            id: ActionId::new(),
            name: "Sort by Amount".into(),
            action_type: ActionType::Click,
            targets: vec![id],
            target_ref: TargetRef::Selector {
                selector: "#invoices th:nth-child(2)".into(),
            },
            preconditions: vec![],
            postconditions: vec![Condition {
                description: "Table is sorted by Amount".into(),
                check: ConditionCheck::EntityState {
                    entity_id: id,
                    field: "sorted_by".into(),
                    expected: json!("Amount"),
                },
            }],
            confidence: 0.7,
            params: None,
        };

        let results = validate_postconditions(&action, &graph);
        assert_eq!(results.len(), 1);
        assert!(!results[0].passed);
        assert!(results[0].message.as_ref().unwrap().contains("Amount"));
    }
}
