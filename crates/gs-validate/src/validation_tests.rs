#[cfg(test)]
mod tests {
    use gs_graph::StateGraph;
    use gs_types::*;
    use serde_json::json;

    use crate::{all_preconditions_met, validate_postconditions, validate_preconditions};

    fn setup_graph_with_entity(props: serde_json::Value) -> (StateGraph, EntityId) {
        let mut graph = StateGraph::new();
        let entity = SemanticEntity::new(
            EntityId(0),
            StableKey::new(EntityKind::Table, "invoices"),
            EntityKind::Table,
            props,
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

    fn make_action_with_preconditions(
        entity_id: EntityId,
        preconditions: Vec<Condition>,
    ) -> Action {
        Action {
            id: ActionId::new(),
            name: "test action".into(),
            action_type: ActionType::Click,
            targets: vec![entity_id],
            target_ref: TargetRef::Selector {
                selector: "#invoices".into(),
            },
            preconditions,
            postconditions: vec![],
            confidence: 0.9,
            params: None,
        }
    }

    fn make_action_with_postconditions(
        entity_id: EntityId,
        postconditions: Vec<Condition>,
    ) -> Action {
        Action {
            id: ActionId::new(),
            name: "test action".into(),
            action_type: ActionType::Click,
            targets: vec![entity_id],
            target_ref: TargetRef::Selector {
                selector: "#invoices".into(),
            },
            preconditions: vec![],
            postconditions,
            confidence: 0.9,
            params: None,
        }
    }

    #[test]
    fn entity_state_check_passes_when_field_matches_exactly() {
        let (graph, id) = setup_graph_with_entity(json!({"sorted_by": "Name", "row_count": 5}));
        let action = make_action_with_postconditions(
            id,
            vec![Condition {
                description: "sorted by Name".into(),
                check: ConditionCheck::EntityState {
                    entity_id: id,
                    field: "sorted_by".into(),
                    expected: json!("Name"),
                },
            }],
        );

        let results = validate_postconditions(&action, &graph);
        assert_eq!(results.len(), 1);
        assert!(results[0].passed);
    }

    #[test]
    fn entity_state_check_fails_when_field_value_differs() {
        let (graph, id) = setup_graph_with_entity(json!({"sorted_by": "Name"}));
        let action = make_action_with_postconditions(
            id,
            vec![Condition {
                description: "sorted by Amount".into(),
                check: ConditionCheck::EntityState {
                    entity_id: id,
                    field: "sorted_by".into(),
                    expected: json!("Amount"),
                },
            }],
        );

        let results = validate_postconditions(&action, &graph);
        assert_eq!(results.len(), 1);
        assert!(!results[0].passed);
        assert!(results[0].message.is_some());
    }

    #[test]
    fn entity_state_check_fails_when_entity_removed() {
        let (mut graph, id) = setup_graph_with_entity(json!({"sorted_by": "Name"}));
        graph.remove(id);
        graph.gc();

        let action = make_action_with_postconditions(
            id,
            vec![Condition {
                description: "sorted by Name".into(),
                check: ConditionCheck::EntityState {
                    entity_id: id,
                    field: "sorted_by".into(),
                    expected: json!("Name"),
                },
            }],
        );

        let results = validate_postconditions(&action, &graph);
        assert_eq!(results.len(), 1);
        assert!(
            !results[0].passed,
            "condition must fail when entity has been GC'd"
        );
        assert!(results[0].actual.is_none());
    }

    #[test]
    fn entity_state_check_with_nested_json_value() {
        let props = json!({
            "metadata": {
                "sort": {"column": "Amount", "direction": "asc"}
            }
        });
        let (graph, id) = setup_graph_with_entity(props);
        let action = make_action_with_postconditions(
            id,
            vec![Condition {
                description: "metadata matches".into(),
                check: ConditionCheck::EntityState {
                    entity_id: id,
                    field: "metadata".into(),
                    expected: json!({"sort": {"column": "Amount", "direction": "asc"}}),
                },
            }],
        );

        let results = validate_postconditions(&action, &graph);
        assert!(results[0].passed, "nested JSON values must compare deeply");
    }

    #[test]
    fn multiple_preconditions_all_must_pass() {
        let (graph, id) = setup_graph_with_entity(json!({"sorted_by": "Name", "row_count": 5}));
        let action = make_action_with_preconditions(
            id,
            vec![
                Condition {
                    description: "sorted by Name".into(),
                    check: ConditionCheck::EntityState {
                        entity_id: id,
                        field: "sorted_by".into(),
                        expected: json!("Name"),
                    },
                },
                Condition {
                    description: "row count is 5".into(),
                    check: ConditionCheck::EntityState {
                        entity_id: id,
                        field: "row_count".into(),
                        expected: json!(5),
                    },
                },
            ],
        );

        assert!(all_preconditions_met(&action, &graph));
        let results = validate_preconditions(&action, &graph);
        assert!(results.iter().all(|r| r.passed));
    }

    #[test]
    fn multiple_preconditions_one_failure_means_not_all_met() {
        let (graph, id) = setup_graph_with_entity(json!({"sorted_by": "Name", "row_count": 5}));
        let action = make_action_with_preconditions(
            id,
            vec![
                Condition {
                    description: "sorted by Name".into(),
                    check: ConditionCheck::EntityState {
                        entity_id: id,
                        field: "sorted_by".into(),
                        expected: json!("Name"),
                    },
                },
                Condition {
                    description: "row count is 10".into(),
                    check: ConditionCheck::EntityState {
                        entity_id: id,
                        field: "row_count".into(),
                        expected: json!(10), // wrong: actual is 5
                    },
                },
            ],
        );

        assert!(
            !all_preconditions_met(&action, &graph),
            "one failing precondition means all_preconditions_met must be false"
        );
    }

    #[test]
    fn action_with_no_preconditions_always_passes() {
        let (graph, id) = setup_graph_with_entity(json!({}));
        let action = make_action_with_preconditions(id, vec![]);

        assert!(all_preconditions_met(&action, &graph));
        assert!(validate_preconditions(&action, &graph).is_empty());
    }

    #[test]
    fn action_with_no_postconditions_always_passes() {
        let (graph, id) = setup_graph_with_entity(json!({}));
        let action = make_action_with_postconditions(id, vec![]);

        let results = validate_postconditions(&action, &graph);
        assert!(results.is_empty());
    }
}
