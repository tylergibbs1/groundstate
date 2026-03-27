#[cfg(test)]
mod tests {
    use gs_types::*;
    use serde_json::json;

    use crate::StateGraph;

    fn make_entity(kind: EntityKind, fingerprint: &str) -> SemanticEntity {
        SemanticEntity::new(
            EntityId(0),
            StableKey::new(kind.clone(), fingerprint),
            kind,
            json!({}),
            SourceRef {
                selector: format!("#{fingerprint}"),
                backend_node_id: None,
                a11y_id: None,
            },
            1.0,
        )
    }

    #[test]
    fn invalidate_leaf_node_only_marks_that_node_stale() {
        let mut graph = StateGraph::new();
        let root = graph.upsert(make_entity(EntityKind::Table, "root"));
        let leaf = graph.upsert(make_entity(EntityKind::TableRow, "leaf"));
        graph.add_relation(leaf, root, Relation::DependsOn);

        let invalidated = graph.invalidate(leaf);

        assert_eq!(invalidated.len(), 1);
        assert_eq!(invalidated[0], leaf);
        assert_eq!(graph.get(leaf).unwrap().status, EntityStatus::Stale);
        assert_eq!(
            graph.get(root).unwrap().status,
            EntityStatus::Fresh,
            "root must not be affected when leaf is invalidated"
        );
    }

    #[test]
    fn invalidate_root_propagates_through_deep_chain() {
        // A -> B -> C -> D  (each DependsOn the previous)
        let mut graph = StateGraph::new();
        let a = graph.upsert(make_entity(EntityKind::Table, "a"));
        let b = graph.upsert(make_entity(EntityKind::Table, "b"));
        let c = graph.upsert(make_entity(EntityKind::Table, "c"));
        let d = graph.upsert(make_entity(EntityKind::Table, "d"));

        graph.add_relation(b, a, Relation::DependsOn);
        graph.add_relation(c, b, Relation::DependsOn);
        graph.add_relation(d, c, Relation::DependsOn);

        let invalidated = graph.invalidate(a);

        assert_eq!(invalidated.len(), 4);
        for id in [a, b, c, d] {
            assert_eq!(
                graph.get(id).unwrap().status,
                EntityStatus::Stale,
                "all nodes in chain must be stale"
            );
        }
    }

    #[test]
    fn diamond_dependency_invalidates_d_once_no_infinite_loop() {
        //   A
        //  / \
        // B   C
        //  \ /
        //   D
        // B depends on A, C depends on A, D depends on B and C
        let mut graph = StateGraph::new();
        let a = graph.upsert(make_entity(EntityKind::Table, "a"));
        let b = graph.upsert(make_entity(EntityKind::Table, "b"));
        let c = graph.upsert(make_entity(EntityKind::Table, "c"));
        let d = graph.upsert(make_entity(EntityKind::Table, "d"));

        graph.add_relation(b, a, Relation::DependsOn);
        graph.add_relation(c, a, Relation::DependsOn);
        graph.add_relation(d, b, Relation::DependsOn);
        graph.add_relation(d, c, Relation::DependsOn);

        let invalidated = graph.invalidate(a);

        // All 4 nodes should be invalidated
        assert_eq!(invalidated.len(), 4);
        for id in [a, b, c, d] {
            assert_eq!(graph.get(id).unwrap().status, EntityStatus::Stale);
        }

        // D must appear exactly once
        let d_count = invalidated.iter().filter(|&&id| id == d).count();
        assert_eq!(d_count, 1, "D must only be invalidated once in diamond");
    }

    #[test]
    fn invalidate_already_stale_entity_is_noop() {
        let mut graph = StateGraph::new();
        let id = graph.upsert(make_entity(EntityKind::Table, "t"));

        let first = graph.invalidate(id);
        assert_eq!(first.len(), 1);
        let version_after_first = graph.version();

        let second = graph.invalidate(id);
        assert!(
            second.is_empty(),
            "invalidating an already-stale entity should be a no-op"
        );
        assert_eq!(
            graph.version(),
            version_after_first,
            "graph version must not bump on no-op invalidation"
        );
    }

    #[test]
    fn invalidate_removed_entity_is_noop() {
        let mut graph = StateGraph::new();
        let id = graph.upsert(make_entity(EntityKind::Table, "t"));
        graph.remove(id);
        let version_before = graph.version();

        let invalidated = graph.invalidate(id);
        assert!(invalidated.is_empty());
        assert_eq!(graph.version(), version_before);
    }

    #[test]
    fn unrelated_entity_not_affected_by_invalidation() {
        let mut graph = StateGraph::new();
        let a = graph.upsert(make_entity(EntityKind::Table, "a"));
        let b = graph.upsert(make_entity(EntityKind::Table, "b"));
        let unrelated = graph.upsert(make_entity(EntityKind::Button, "btn"));

        graph.add_relation(b, a, Relation::DependsOn);

        graph.invalidate(a);

        assert_eq!(graph.get(a).unwrap().status, EntityStatus::Stale);
        assert_eq!(graph.get(b).unwrap().status, EntityStatus::Stale);
        assert_eq!(
            graph.get(unrelated).unwrap().status,
            EntityStatus::Fresh,
            "unrelated entity must remain fresh"
        );
    }

    #[test]
    fn only_depends_on_edges_propagate_invalidation_not_child_of() {
        let mut graph = StateGraph::new();
        let parent = graph.upsert(make_entity(EntityKind::Table, "parent"));
        let child = graph.upsert(make_entity(EntityKind::TableRow, "child"));
        let dependent = graph.upsert(make_entity(EntityKind::TableRow, "dep"));

        graph.add_relation(child, parent, Relation::ChildOf);
        graph.add_relation(dependent, parent, Relation::DependsOn);

        let invalidated = graph.invalidate(parent);

        // parent and dependent should be stale; child (ChildOf only) should not
        assert!(
            invalidated.contains(&parent),
            "parent must be invalidated"
        );
        assert!(
            invalidated.contains(&dependent),
            "DependsOn dependent must be invalidated"
        );
        assert_eq!(
            graph.get(child).unwrap().status,
            EntityStatus::Fresh,
            "ChildOf edge must NOT propagate invalidation"
        );
    }

    #[test]
    fn re_upsert_stale_entity_becomes_fresh() {
        let mut graph = StateGraph::new();
        let id = graph.upsert(make_entity(EntityKind::Table, "t"));

        graph.invalidate(id);
        assert_eq!(graph.get(id).unwrap().status, EntityStatus::Stale);

        // Re-upsert with new data (simulates re-extraction after rerender)
        graph.upsert(make_entity(EntityKind::Table, "t"));
        assert_eq!(
            graph.get(id).unwrap().status,
            EntityStatus::Fresh,
            "re-upserting a stale entity must mark it Fresh"
        );
    }
}
