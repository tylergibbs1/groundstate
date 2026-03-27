use gs_graph::StateGraph;
use gs_types::*;

/// Derives candidate actions for entities in the state graph.
pub struct ActionDeriver;

impl ActionDeriver {
    /// Derive available actions for a specific entity.
    pub fn derive_actions(entity: &SemanticEntity, graph: &StateGraph) -> Vec<Action> {
        match &entity.kind {
            EntityKind::Table => derive_table_actions(entity, graph),
            EntityKind::TableRow => derive_table_row_actions(entity),
            EntityKind::Button => derive_button_actions(entity),
            EntityKind::Link => derive_link_actions(entity),
            EntityKind::SearchResult => derive_search_result_actions(entity),
            EntityKind::FormField => derive_form_field_actions(entity),
            _ => vec![],
        }
    }

    /// Derive actions for a set of entity IDs.
    pub fn derive_actions_for_ids(entity_ids: &[EntityId], graph: &StateGraph) -> Vec<Action> {
        entity_ids
            .iter()
            .filter_map(|id| graph.get(*id))
            .flat_map(|entity| Self::derive_actions(entity, graph))
            .collect()
    }
}

fn derive_table_actions(table: &SemanticEntity, _graph: &StateGraph) -> Vec<Action> {
    let mut actions = Vec::new();
    let headers = table
        .properties
        .get("headers")
        .and_then(|h| h.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    // Sort by column header
    for (col_idx, header) in headers.iter().enumerate() {
        actions.push(Action {
            id: ActionId::new(),
            name: format!("Sort by {header}"),
            action_type: ActionType::Click,
            targets: vec![table.id],
            target_ref: TargetRef::Selector {
                selector: format!(
                    "{} th:nth-child({})",
                    table.source.selector,
                    col_idx + 1
                ),
            },
            preconditions: vec![Condition {
                description: format!("Table header '{header}' is visible"),
                check: ConditionCheck::ElementVisible {
                    selector: format!(
                        "{} th:nth-child({})",
                        table.source.selector,
                        col_idx + 1
                    ),
                },
            }],
            postconditions: vec![Condition {
                description: format!("Table is sorted by {header}"),
                check: ConditionCheck::EntityState {
                    entity_id: table.id,
                    field: "sorted_by".into(),
                    expected: serde_json::Value::String(header.clone()),
                },
            }],
            confidence: 0.7,
            params: None,
        });
    }

    actions
}

fn derive_table_row_actions(row: &SemanticEntity) -> Vec<Action> {
    vec![Action {
        id: ActionId::new(),
        name: "Click row".into(),
        action_type: ActionType::Click,
        targets: vec![row.id],
        target_ref: TargetRef::Selector {
            selector: row.source.selector.clone(),
        },
        preconditions: vec![Condition {
            description: "Row is visible".into(),
            check: ConditionCheck::ElementVisible {
                selector: row.source.selector.clone(),
            },
        }],
        postconditions: vec![],
        confidence: 0.8,
        params: None,
    }]
}

fn derive_button_actions(button: &SemanticEntity) -> Vec<Action> {
    if button
        .properties
        .get("disabled")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        return vec![];
    }

    let name = button
        .properties
        .get("label")
        .and_then(|v| v.as_str())
        .unwrap_or("button");

    vec![Action {
        id: ActionId::new(),
        name: format!("Click {name}"),
        action_type: ActionType::Click,
        targets: vec![button.id],
        target_ref: entity_target_ref(button),
        preconditions: vec![Condition {
            description: format!("Button '{name}' is visible and enabled"),
            check: ConditionCheck::ElementVisible {
                selector: button.source.selector.clone(),
            },
        }],
        postconditions: vec![],
        confidence: 0.9,
        params: None,
    }]
}

fn derive_link_actions(link: &SemanticEntity) -> Vec<Action> {
    let href = link
        .properties
        .get("href")
        .and_then(|v| v.as_str())
        .unwrap_or("#");
    let text = link
        .properties
        .get("text")
        .and_then(|v| v.as_str())
        .unwrap_or("link");

    vec![Action {
        id: ActionId::new(),
        name: format!("Open {text}"),
        action_type: ActionType::Navigate,
        targets: vec![link.id],
        target_ref: entity_target_ref(link),
        preconditions: vec![Condition {
            description: format!("Link '{text}' is visible"),
            check: ConditionCheck::ElementVisible {
                selector: link.source.selector.clone(),
            },
        }],
        postconditions: vec![Condition {
            description: format!("URL matches {href}"),
            check: ConditionCheck::UrlMatches {
                pattern: href.to_string(),
            },
        }],
        confidence: 0.85,
        params: Some(serde_json::json!({ "url": href })),
    }]
}

fn derive_search_result_actions(result: &SemanticEntity) -> Vec<Action> {
    let title = result
        .properties
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("result");
    let href = result
        .properties
        .get("href")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    if href.is_empty() {
        return vec![];
    }

    vec![Action {
        id: ActionId::new(),
        name: format!("Open result: {title}"),
        action_type: ActionType::Navigate,
        targets: vec![result.id],
        target_ref: entity_target_ref(result),
        preconditions: vec![Condition {
            description: format!("Result '{title}' is visible"),
            check: ConditionCheck::ElementVisible {
                selector: result.source.selector.clone(),
            },
        }],
        postconditions: vec![Condition {
            description: format!("URL matches {href}"),
            check: ConditionCheck::UrlMatches {
                pattern: href.to_string(),
            },
        }],
        confidence: 0.82,
        params: Some(serde_json::json!({ "url": href })),
    }]
}

fn derive_form_field_actions(field: &SemanticEntity) -> Vec<Action> {
    let label = field
        .properties
        .get("label")
        .and_then(|v| v.as_str())
        .unwrap_or("field");

    vec![Action {
        id: ActionId::new(),
        name: format!("Fill {label}"),
        action_type: ActionType::Fill,
        targets: vec![field.id],
        target_ref: entity_target_ref(field),
        preconditions: vec![Condition {
            description: format!("Field '{label}' is visible and enabled"),
            check: ConditionCheck::ElementVisible {
                selector: field.source.selector.clone(),
            },
        }],
        postconditions: vec![],
        confidence: 0.9,
        params: Some(serde_json::json!({"value": ""})),
    }]
}

fn entity_target_ref(entity: &SemanticEntity) -> TargetRef {
    if let Some(id) = entity.source.backend_node_id {
        return TargetRef::BackendNodeId { id };
    }

    TargetRef::Selector {
        selector: entity.source.selector.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn make_table_entity(headers: Vec<&str>) -> SemanticEntity {
        let id = EntityId(0);
        SemanticEntity::new(
            id,
            StableKey::new(EntityKind::Table, "test-table"),
            EntityKind::Table,
            json!({
                "headers": headers,
                "row_count": 5,
            }),
            SourceRef {
                selector: "#invoices".into(),
                backend_node_id: Some(100),
                a11y_id: None,
            },
            0.9,
        )
    }

    #[test]
    fn derives_sort_actions_for_table() {
        let mut graph = StateGraph::new();
        let entity = make_table_entity(vec!["Name", "Amount", "Status"]);
        let id = graph.upsert(entity);

        let entity = graph.get(id).unwrap();
        let actions = ActionDeriver::derive_actions(entity, &graph);

        assert_eq!(actions.len(), 3);
        assert_eq!(actions[0].name, "Sort by Name");
        assert_eq!(actions[1].name, "Sort by Amount");
        assert_eq!(actions[2].name, "Sort by Status");

        // Each should have a precondition and postcondition
        assert_eq!(actions[0].preconditions.len(), 1);
        assert_eq!(actions[0].postconditions.len(), 1);
    }

    #[test]
    fn derives_click_action_for_row() {
        let row = SemanticEntity::new(
            EntityId(0),
            StableKey::new(EntityKind::TableRow, "row-0"),
            EntityKind::TableRow,
            json!({"Name": "Acme"}),
            SourceRef {
                selector: "#invoices tr:nth-child(1)".into(),
                backend_node_id: None,
                a11y_id: None,
            },
            0.85,
        );

        let graph = StateGraph::new();
        let actions = ActionDeriver::derive_actions(&row, &graph);

        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0].name, "Click row");
        assert_eq!(actions[0].action_type, ActionType::Click);
    }
}
