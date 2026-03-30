use std::collections::HashSet;

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
fn subscribe_receives_matching_upserts_only() {
    let mut graph = StateGraph::new();
    let (_sub_id, rx) = graph.subscribe(Some(EntityKind::Button));

    graph.upsert(make_entity(
        EntityKind::Button,
        "b1",
        json!({"label": "OK"}),
    ));
    graph.upsert(make_entity(EntityKind::Table, "t1", json!({})));
    graph.upsert(make_entity(
        EntityKind::Button,
        "b2",
        json!({"label": "Cancel"}),
    ));

    // Should receive exactly 2 diffs (the two buttons), not the table
    let diff1 = rx.try_recv().unwrap();
    assert_eq!(diff1.upserted.len(), 1);
    assert_eq!(diff1.upserted[0].kind, EntityKind::Button);

    let diff2 = rx.try_recv().unwrap();
    assert_eq!(diff2.upserted.len(), 1);
    assert_eq!(diff2.upserted[0].kind, EntityKind::Button);

    assert!(rx.try_recv().is_err());
}

#[test]
fn subscribe_none_receives_all_kinds() {
    let mut graph = StateGraph::new();
    let (_sub_id, rx) = graph.subscribe(None);

    graph.upsert(make_entity(EntityKind::Button, "b1", json!({})));
    graph.upsert(make_entity(EntityKind::Table, "t1", json!({})));
    graph.upsert(make_entity(EntityKind::Link, "l1", json!({})));

    // Should receive all 3
    let _ = rx.try_recv().unwrap();
    let _ = rx.try_recv().unwrap();
    let _ = rx.try_recv().unwrap();
    assert!(rx.try_recv().is_err());
}

#[test]
fn upsert_diffs_arrive_in_order() {
    let mut graph = StateGraph::new();
    let (_sub_id, rx) = graph.subscribe(Some(EntityKind::Button));

    for i in 0..10 {
        graph.upsert(make_entity(
            EntityKind::Button,
            &format!("b{i}"),
            json!({"index": i}),
        ));
    }

    for i in 0..10 {
        let diff = rx.try_recv().unwrap();
        assert_eq!(diff.upserted[0].properties["index"], i);
    }
    assert!(rx.try_recv().is_err());
}

#[test]
fn unsubscribe_stops_diffs() {
    let mut graph = StateGraph::new();
    let (sub_id, rx) = graph.subscribe(Some(EntityKind::Button));

    graph.upsert(make_entity(EntityKind::Button, "b1", json!({})));
    assert!(rx.try_recv().is_ok());

    graph.unsubscribe(sub_id);

    graph.upsert(make_entity(EntityKind::Button, "b2", json!({})));
    assert!(rx.try_recv().is_err());
}

#[test]
fn dropped_receiver_cleans_up_subscription() {
    let mut graph = StateGraph::new();
    let (_sub_id, rx) = graph.subscribe(Some(EntityKind::Button));
    drop(rx);

    // This upsert should detect the dead subscription and clean it up
    graph.upsert(make_entity(EntityKind::Button, "b1", json!({})));
    assert_eq!(graph.subscriptions.len(), 0);
}

#[test]
fn invalidate_notifies_subscribers() {
    let mut graph = StateGraph::new();
    let id = graph.upsert(make_entity(EntityKind::Button, "b1", json!({})));

    let (_sub_id, rx) = graph.subscribe(Some(EntityKind::Button));

    graph.invalidate(id);

    let diff = rx.try_recv().unwrap();
    assert!(diff.upserted.is_empty());
    assert_eq!(diff.invalidated, vec![id]);
    assert!(diff.removed.is_empty());
}

#[test]
fn invalidate_propagation_notifies_for_all_kinds() {
    let mut graph = StateGraph::new();
    let table_id = graph.upsert(make_entity(EntityKind::Table, "t1", json!({})));
    let row_id = graph.upsert(make_entity(EntityKind::TableRow, "r1", json!({})));
    graph.add_relation(row_id, table_id, Relation::DependsOn);

    // Subscribe to all kinds
    let (_sub_id, rx) = graph.subscribe(None);

    graph.invalidate(table_id);

    let diff = rx.try_recv().unwrap();
    assert_eq!(diff.invalidated.len(), 2);
    assert!(diff.invalidated.contains(&table_id));
    assert!(diff.invalidated.contains(&row_id));
}

#[test]
fn remove_notifies_subscribers() {
    let mut graph = StateGraph::new();
    let id = graph.upsert(make_entity(EntityKind::Button, "b1", json!({})));

    let (_sub_id, rx) = graph.subscribe(Some(EntityKind::Button));

    graph.remove(id);

    let diff = rx.try_recv().unwrap();
    assert!(diff.upserted.is_empty());
    assert!(diff.invalidated.is_empty());
    assert_eq!(diff.removed, vec![id]);
}

#[test]
fn remove_does_not_notify_unrelated_subscription() {
    let mut graph = StateGraph::new();
    let id = graph.upsert(make_entity(EntityKind::Table, "t1", json!({})));

    let (_sub_id, rx) = graph.subscribe(Some(EntityKind::Button));

    graph.remove(id);

    assert!(rx.try_recv().is_err());
}

#[test]
fn reconcile_removes_missing_entities() {
    let mut graph = StateGraph::new();
    let key_a = StableKey::new(EntityKind::Button, "a");
    let key_b = StableKey::new(EntityKind::Button, "b");
    graph.upsert(make_entity(EntityKind::Button, "a", json!({})));
    graph.upsert(make_entity(EntityKind::Button, "b", json!({})));
    let id_c = graph.upsert(make_entity(EntityKind::Button, "c", json!({})));

    let (_sub_id, rx) = graph.subscribe(Some(EntityKind::Button));

    // Only "a" and "b" were seen in the latest extraction
    let seen: HashSet<StableKey> = [key_a, key_b].into_iter().collect();
    let removed = graph.reconcile(&seen);

    assert_eq!(removed.len(), 1);
    assert_eq!(removed[0], id_c);
    assert_eq!(graph.get(id_c).unwrap().status, EntityStatus::Removed);

    // Subscription should have been notified
    let diff = rx.try_recv().unwrap();
    assert_eq!(diff.removed, vec![id_c]);

    // "a" and "b" should still be fresh
    let fresh = graph.query(&EntityKind::Button, None);
    assert_eq!(fresh.len(), 2);
}

#[test]
fn reconcile_skips_already_removed() {
    let mut graph = StateGraph::new();
    let id = graph.upsert(make_entity(EntityKind::Button, "a", json!({})));
    graph.remove(id);

    let removed = graph.reconcile(&HashSet::new());
    assert!(removed.is_empty());
}

#[test]
fn reconcile_with_mixed_kinds() {
    let mut graph = StateGraph::new();
    let key_b = StableKey::new(EntityKind::Button, "b1");
    let key_t = StableKey::new(EntityKind::Table, "t1");

    graph.upsert(make_entity(EntityKind::Button, "b1", json!({})));
    let table_id = graph.upsert(make_entity(EntityKind::Table, "t1", json!({})));
    let link_id = graph.upsert(make_entity(EntityKind::Link, "l1", json!({})));

    // Only button and table were re-extracted — link should be removed
    let seen: HashSet<StableKey> = [key_b, key_t].into_iter().collect();
    let removed = graph.reconcile(&seen);

    assert_eq!(removed.len(), 1);
    assert_eq!(removed[0], link_id);
    assert_eq!(graph.get(table_id).unwrap().status, EntityStatus::Fresh);
}

#[test]
fn multiple_subscriptions_independent() {
    let mut graph = StateGraph::new();
    let (_sub1, rx1) = graph.subscribe(Some(EntityKind::Button));
    let (_sub2, rx2) = graph.subscribe(Some(EntityKind::Table));
    let (_sub3, rx3) = graph.subscribe(None);

    graph.upsert(make_entity(EntityKind::Button, "b1", json!({})));

    // rx1 (Button filter) and rx3 (no filter) should get it
    assert!(rx1.try_recv().is_ok());
    assert!(rx2.try_recv().is_err());
    assert!(rx3.try_recv().is_ok());
}

#[test]
fn graph_version_in_diff_matches_graph() {
    let mut graph = StateGraph::new();
    let (_sub_id, rx) = graph.subscribe(None);

    graph.upsert(make_entity(EntityKind::Button, "b1", json!({})));

    let diff = rx.try_recv().unwrap();
    assert_eq!(diff.graph_version, graph.version());
}
