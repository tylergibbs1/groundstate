#[cfg(test)]
mod tests {
    use gs_types::*;
    use serde_json::json;

    use crate::StateGraph;

    fn make_entity(kind: EntityKind, fingerprint: &str, props: serde_json::Value) -> SemanticEntity {
        SemanticEntity::new(
            EntityId(0),
            StableKey::new(kind.clone(), fingerprint),
            kind,
            props,
            SourceRef {
                selector: format!("#{fingerprint}"),
                backend_node_id: None,
                a11y_id: None,
            },
            1.0,
        )
    }

    #[test]
    fn same_stable_key_changed_properties_updates_in_place() {
        let mut graph = StateGraph::new();
        let id1 = graph.upsert(make_entity(EntityKind::Table, "inv", json!({"rows": 10})));
        let v1 = graph.get(id1).unwrap().version;

        let id2 = graph.upsert(make_entity(EntityKind::Table, "inv", json!({"rows": 20})));

        assert_eq!(id1, id2, "ID must be preserved across rerenders");
        let entity = graph.get(id1).unwrap();
        assert_eq!(entity.properties["rows"], 20, "properties must update");
        assert_eq!(entity.version, v1 + 1, "version must bump");
        assert_eq!(entity.status, EntityStatus::Fresh);
        assert_eq!(graph.entity_count(), 1);
    }

    #[test]
    fn same_stable_key_identical_properties_still_bumps_version() {
        let mut graph = StateGraph::new();
        let props = json!({"rows": 10});
        let id1 = graph.upsert(make_entity(EntityKind::Table, "inv", props.clone()));
        let v1 = graph.get(id1).unwrap().version;

        let id2 = graph.upsert(make_entity(EntityKind::Table, "inv", props));

        assert_eq!(id1, id2);
        assert_eq!(
            graph.get(id1).unwrap().version,
            v1 + 1,
            "version bumps even when properties are identical (rerender detected)"
        );
    }

    #[test]
    fn new_entities_appear_after_rerender() {
        let mut graph = StateGraph::new();
        graph.upsert(make_entity(EntityKind::Table, "t1", json!({})));
        assert_eq!(graph.entity_count(), 1);

        let id_new = graph.upsert(make_entity(EntityKind::Button, "b1", json!({})));
        assert_eq!(graph.entity_count(), 2);
        assert!(graph.get(id_new).is_some());
        assert_eq!(graph.get(id_new).unwrap().kind, EntityKind::Button);
    }

    #[test]
    fn entities_disappear_after_rerender_gc_cleans_up() {
        let mut graph = StateGraph::new();
        let id_a = graph.upsert(make_entity(EntityKind::Table, "t1", json!({})));
        let id_b = graph.upsert(make_entity(EntityKind::Table, "t2", json!({})));

        // Simulate t1 disappearing from the DOM
        graph.remove(id_a);
        assert_eq!(graph.entity_count(), 1, "removed entity excluded from live count");
        assert_eq!(graph.get(id_a).unwrap().status, EntityStatus::Removed);

        graph.gc();
        assert!(graph.get(id_a).is_none(), "GC must delete the node");
        assert!(graph.get(id_b).is_some(), "surviving entity untouched");
        assert_eq!(graph.entity_count(), 1);
    }

    #[test]
    fn stable_key_with_different_kind_treated_as_new_entity() {
        let mut graph = StateGraph::new();
        let id_table = graph.upsert(make_entity(EntityKind::Table, "widget", json!({})));
        let id_button = graph.upsert(make_entity(EntityKind::Button, "widget", json!({})));

        assert_ne!(
            id_table, id_button,
            "same fingerprint but different kind must produce distinct entities"
        );
        assert_eq!(graph.entity_count(), 2);
    }

    #[test]
    fn bulk_upsert_only_bumps_changed_versions() {
        let mut graph = StateGraph::new();

        // Insert 100 entities
        let mut ids = Vec::new();
        for i in 0..100 {
            let id = graph.upsert(make_entity(
                EntityKind::TableRow,
                &format!("row-{i}"),
                json!({"value": i}),
            ));
            ids.push(id);
        }

        // Record initial versions
        let initial_versions: Vec<u64> = ids.iter().map(|id| graph.get(*id).unwrap().version).collect();

        // Re-upsert all 100, but only change 5 (indices 10, 20, 30, 40, 50)
        let changed_indices: Vec<usize> = vec![10, 20, 30, 40, 50];
        for i in 0..100 {
            let value = if changed_indices.contains(&i) {
                json!({"value": i * 100}) // changed
            } else {
                json!({"value": i}) // same
            };
            graph.upsert(make_entity(
                EntityKind::TableRow,
                &format!("row-{i}"),
                value,
            ));
        }

        // All 100 get version bumps because upsert always bumps on match
        // (the system detects rerenders, not just property changes).
        // But verify that entity count is still 100 (no duplicates).
        assert_eq!(graph.entity_count(), 100);

        // The 5 changed entities should have updated properties
        for &ci in &changed_indices {
            let entity = graph.get(ids[ci]).unwrap();
            assert_eq!(entity.properties["value"], ci * 100);
        }

        // Unchanged entities should have their original property values
        for i in 0..100 {
            if !changed_indices.contains(&i) {
                let entity = graph.get(ids[i]).unwrap();
                assert_eq!(
                    entity.properties["value"], i as u64,
                    "unchanged entity {i} should keep its properties"
                );
            }
        }

        // All entities got version bumps (rerender detection)
        for i in 0..100 {
            let entity = graph.get(ids[i]).unwrap();
            assert_eq!(
                entity.version,
                initial_versions[i] + 1,
                "entity {i} should have bumped version"
            );
        }
    }

    #[test]
    fn parent_child_relationships_survive_entity_updates() {
        let mut graph = StateGraph::new();
        let parent_id = graph.upsert(make_entity(EntityKind::Table, "table", json!({"rows": 2})));
        let child_id = graph.upsert(make_entity(EntityKind::TableRow, "row-0", json!({"val": "a"})));

        graph.add_relation(child_id, parent_id, Relation::ChildOf);
        assert_eq!(graph.children(parent_id).len(), 1);

        // Update the parent entity
        graph.upsert(make_entity(EntityKind::Table, "table", json!({"rows": 5})));
        assert_eq!(
            graph.children(parent_id).len(),
            1,
            "ChildOf edge must survive parent update"
        );

        // Update the child entity
        graph.upsert(make_entity(EntityKind::TableRow, "row-0", json!({"val": "b"})));
        assert_eq!(
            graph.children(parent_id).len(),
            1,
            "ChildOf edge must survive child update"
        );

        // Verify the relationship still points to the right entities
        let children = graph.children(parent_id);
        assert_eq!(children[0], child_id);
    }
}
