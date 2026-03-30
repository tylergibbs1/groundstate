pub mod subscription;

#[cfg(test)]
mod invalidation_tests;
#[cfg(test)]
mod reconciliation_tests;
#[cfg(test)]
mod subscription_tests;

use std::collections::{HashMap, HashSet};
use std::sync::mpsc;

use gs_types::{EntityId, EntityKind, EntityStatus, Relation, SemanticEntity, StableKey};
use petgraph::Direction;
use petgraph::stable_graph::StableGraph;

pub use subscription::{EntitySnapshot, GraphDiff, SubscriptionId};

/// The authoritative state graph for a browser session.
///
/// Entities are nodes, relations are edges. Uses `petgraph::StableGraph`
/// so that node indices remain valid when entities are removed.
pub struct StateGraph {
    graph: StableGraph<SemanticEntity, Relation>,
    stable_index: HashMap<StableKey, EntityId>,
    version: u64,
    subscriptions: Vec<subscription::Subscription>,
    next_sub_id: u64,
}

impl Default for StateGraph {
    fn default() -> Self {
        Self::new()
    }
}

impl StateGraph {
    pub fn new() -> Self {
        Self {
            graph: StableGraph::new(),
            stable_index: HashMap::new(),
            version: 0,
            subscriptions: Vec::new(),
            next_sub_id: 0,
        }
    }

    /// Current graph version. Incremented on every mutation.
    pub fn version(&self) -> u64 {
        self.version
    }

    /// Total number of live (non-removed) entities.
    pub fn entity_count(&self) -> usize {
        self.graph
            .node_indices()
            .filter(|&idx| {
                self.graph
                    .node_weight(idx)
                    .is_some_and(|e| e.status != EntityStatus::Removed)
            })
            .count()
    }

    /// Subscribe to graph changes, optionally filtered by entity kind.
    /// Returns a subscription handle and a receiver for diffs.
    pub fn subscribe(
        &mut self,
        kind: Option<EntityKind>,
    ) -> (SubscriptionId, mpsc::Receiver<GraphDiff>) {
        let id = SubscriptionId(self.next_sub_id);
        self.next_sub_id += 1;
        let (tx, rx) = mpsc::channel();
        self.subscriptions.push(subscription::Subscription {
            id,
            kind_filter: kind,
            tx,
        });
        (id, rx)
    }

    /// Remove a subscription.
    pub fn unsubscribe(&mut self, id: SubscriptionId) {
        self.subscriptions.retain(|s| s.id != id);
    }

    /// Notify matching subscribers of an upsert.
    fn notify_upsert(&mut self, entity_id: EntityId) {
        let entity = match self.graph.node_weight(entity_id.to_node_index()) {
            Some(e) => e,
            None => return,
        };
        let snapshot = EntitySnapshot::from(entity);
        let kind = entity.kind.clone();
        let version = self.version;

        self.subscriptions.retain(|sub| {
            if sub.matches(&kind) {
                sub.send(GraphDiff {
                    graph_version: version,
                    upserted: vec![snapshot.clone()],
                    invalidated: vec![],
                    removed: vec![],
                })
            } else {
                // Keep non-matching subscriptions alive
                true
            }
        });
    }

    /// Notify matching subscribers of invalidations.
    fn notify_invalidated(&mut self, invalidated: &[EntityId]) {
        if invalidated.is_empty() {
            return;
        }
        // Collect kinds for the invalidated entities
        let kinds: Vec<EntityKind> = invalidated
            .iter()
            .filter_map(|id| self.graph.node_weight(id.to_node_index()))
            .map(|e| e.kind.clone())
            .collect();

        let version = self.version;
        let invalidated_ids = invalidated.to_vec();

        self.subscriptions.retain(|sub| {
            if kinds.iter().any(|k| sub.matches(k)) {
                sub.send(GraphDiff {
                    graph_version: version,
                    upserted: vec![],
                    invalidated: invalidated_ids.clone(),
                    removed: vec![],
                })
            } else {
                true
            }
        });
    }

    /// Notify matching subscribers of a removal.
    fn notify_removed(&mut self, entity_id: EntityId, kind: &EntityKind) {
        let version = self.version;
        self.subscriptions.retain(|sub| {
            if sub.matches(kind) {
                sub.send(GraphDiff {
                    graph_version: version,
                    upserted: vec![],
                    invalidated: vec![],
                    removed: vec![entity_id],
                })
            } else {
                true
            }
        });
    }

    /// Insert a new entity or update an existing one with the same stable key.
    /// Returns the entity ID (stable across calls with the same key).
    pub fn upsert(&mut self, entity: SemanticEntity) -> EntityId {
        self.version += 1;

        let entity_id = if let Some(&existing_id) = self.stable_index.get(&entity.stable_key) {
            let idx = existing_id.to_node_index();
            if let Some(existing) = self.graph.node_weight_mut(idx) {
                existing.properties = entity.properties;
                existing.source = entity.source;
                existing.confidence = entity.confidence;
                existing.bump_version();
            }
            existing_id
        } else {
            let stable_key = entity.stable_key.clone();
            let idx = self.graph.add_node(entity);
            let entity_id = EntityId::from_node_index(idx);
            // Update the entity's own ID to match its graph position
            if let Some(node) = self.graph.node_weight_mut(idx) {
                node.id = entity_id;
            }
            self.stable_index.insert(stable_key, entity_id);
            entity_id
        };

        self.notify_upsert(entity_id);
        entity_id
    }

    /// Mark an entity as removed. Does not delete the graph node (preserves indices).
    pub fn remove(&mut self, entity_id: EntityId) {
        let idx = entity_id.to_node_index();
        let kind = self.graph.node_weight(idx).map(|e| e.kind.clone());
        if let Some(entity) = self.graph.node_weight_mut(idx) {
            entity.mark_removed();
            self.version += 1;
        }
        if let Some(kind) = kind {
            self.notify_removed(entity_id, &kind);
        }
    }

    /// Get an entity by ID.
    pub fn get(&self, entity_id: EntityId) -> Option<&SemanticEntity> {
        self.graph.node_weight(entity_id.to_node_index())
    }

    /// Get a mutable reference to an entity by ID.
    pub fn get_mut(&mut self, entity_id: EntityId) -> Option<&mut SemanticEntity> {
        self.graph.node_weight_mut(entity_id.to_node_index())
    }

    /// Look up an entity by its stable key.
    pub fn get_by_key(&self, key: &StableKey) -> Option<&SemanticEntity> {
        self.stable_index.get(key).and_then(|&id| self.get(id))
    }

    /// Query entities by kind, with an optional property filter.
    pub fn query(
        &self,
        kind: &EntityKind,
        filter: Option<&dyn Fn(&SemanticEntity) -> bool>,
    ) -> Vec<&SemanticEntity> {
        self.graph
            .node_indices()
            .filter_map(|idx| self.graph.node_weight(idx))
            .filter(|e| e.status != EntityStatus::Removed && &e.kind == kind)
            .filter(|e| filter.as_ref().is_none_or(|f| f(e)))
            .collect()
    }

    /// Get all live entities.
    pub fn all_entities(&self) -> Vec<&SemanticEntity> {
        self.graph
            .node_indices()
            .filter_map(|idx| self.graph.node_weight(idx))
            .filter(|e| e.status != EntityStatus::Removed)
            .collect()
    }

    /// Add a directed relation between two entities.
    pub fn add_relation(&mut self, from: EntityId, to: EntityId, relation: Relation) {
        self.graph
            .add_edge(from.to_node_index(), to.to_node_index(), relation);
        self.version += 1;
    }

    /// Get all entities that directly depend on the given entity.
    pub fn dependents(&self, entity_id: EntityId) -> Vec<EntityId> {
        self.graph
            .neighbors_directed(entity_id.to_node_index(), Direction::Incoming)
            .filter(|&idx| {
                self.graph
                    .edges_connecting(idx, entity_id.to_node_index())
                    .any(|e| matches!(e.weight(), Relation::DependsOn))
            })
            .map(EntityId::from_node_index)
            .collect()
    }

    /// Get children of an entity (entities that are ChildOf this one).
    pub fn children(&self, entity_id: EntityId) -> Vec<EntityId> {
        self.graph
            .neighbors_directed(entity_id.to_node_index(), Direction::Incoming)
            .filter(|&idx| {
                self.graph
                    .edges_connecting(idx, entity_id.to_node_index())
                    .any(|e| matches!(e.weight(), Relation::ChildOf))
            })
            .map(EntityId::from_node_index)
            .collect()
    }

    /// Mark an entity and all its transitive dependents as stale.
    /// Returns the set of entity IDs that were invalidated.
    pub fn invalidate(&mut self, entity_id: EntityId) -> Vec<EntityId> {
        let mut invalidated = Vec::new();
        let mut stack = vec![entity_id];

        while let Some(current) = stack.pop() {
            if let Some(entity) = self.graph.node_weight_mut(current.to_node_index()) {
                if entity.status == EntityStatus::Stale || entity.status == EntityStatus::Removed {
                    continue;
                }
                entity.mark_stale();
                invalidated.push(current);
            }

            for dep in self.dependents(current) {
                if self
                    .get(dep)
                    .is_some_and(|e| e.status == EntityStatus::Fresh)
                {
                    stack.push(dep);
                }
            }
        }

        if !invalidated.is_empty() {
            self.version += 1;
            self.notify_invalidated(&invalidated);
        }

        invalidated
    }

    /// Resolve a stable key to an entity ID.
    pub fn resolve_key(&self, key: &StableKey) -> Option<EntityId> {
        self.stable_index.get(key).copied()
    }

    /// Clear all removed entities from the graph and stable index.
    pub fn gc(&mut self) {
        let removed: Vec<_> = self
            .graph
            .node_indices()
            .filter(|&idx| {
                self.graph
                    .node_weight(idx)
                    .is_some_and(|e| e.status == EntityStatus::Removed)
            })
            .collect();

        for idx in removed {
            if let Some(entity) = self.graph.node_weight(idx) {
                self.stable_index.remove(&entity.stable_key);
            }
            self.graph.remove_node(idx);
        }

        if self.graph.node_count() > 0 {
            self.version += 1;
        }
    }

    /// Mark entities not present in `seen_keys` as Removed.
    /// Returns the IDs of newly removed entities.
    pub fn reconcile(&mut self, seen_keys: &HashSet<StableKey>) -> Vec<EntityId> {
        let to_remove: Vec<(EntityId, EntityKind)> = self
            .stable_index
            .iter()
            .filter_map(|(key, &id)| {
                if seen_keys.contains(key) {
                    return None;
                }
                let entity = self.graph.node_weight(id.to_node_index())?;
                if entity.status == EntityStatus::Removed {
                    return None;
                }
                Some((id, entity.kind.clone()))
            })
            .collect();

        if to_remove.is_empty() {
            return vec![];
        }

        let mut removed_ids = Vec::with_capacity(to_remove.len());
        for &(id, _) in &to_remove {
            if let Some(entity) = self.graph.node_weight_mut(id.to_node_index()) {
                entity.mark_removed();
                removed_ids.push(id);
            }
        }

        self.version += 1;

        // Notify per-kind so subscriptions only receive relevant removals
        for (id, kind) in &to_remove {
            self.notify_removed(*id, kind);
        }

        removed_ids
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gs_types::SourceRef;
    use serde_json::json;

    fn make_entity(
        kind: EntityKind,
        fingerprint: &str,
        props: serde_json::Value,
    ) -> SemanticEntity {
        SemanticEntity::new(
            EntityId(0), // placeholder, overwritten by upsert
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
    fn upsert_inserts_new_entity() {
        let mut graph = StateGraph::new();
        let entity = make_entity(EntityKind::Table, "invoices", json!({"rows": 10}));
        let id = graph.upsert(entity);

        let retrieved = graph.get(id).unwrap();
        assert_eq!(retrieved.kind, EntityKind::Table);
        assert_eq!(retrieved.properties["rows"], 10);
        assert_eq!(retrieved.version, 1);
        assert_eq!(graph.entity_count(), 1);
    }

    #[test]
    fn upsert_updates_existing_entity() {
        let mut graph = StateGraph::new();
        let entity1 = make_entity(EntityKind::Table, "invoices", json!({"rows": 10}));
        let id1 = graph.upsert(entity1);

        let entity2 = make_entity(EntityKind::Table, "invoices", json!({"rows": 15}));
        let id2 = graph.upsert(entity2);

        assert_eq!(id1, id2);
        let retrieved = graph.get(id1).unwrap();
        assert_eq!(retrieved.properties["rows"], 15);
        assert_eq!(retrieved.version, 2);
        assert_eq!(graph.entity_count(), 1);
    }

    #[test]
    fn query_filters_by_kind() {
        let mut graph = StateGraph::new();
        graph.upsert(make_entity(EntityKind::Table, "t1", json!({})));
        graph.upsert(make_entity(EntityKind::Button, "b1", json!({})));
        graph.upsert(make_entity(EntityKind::Table, "t2", json!({})));

        let tables = graph.query(&EntityKind::Table, None);
        assert_eq!(tables.len(), 2);

        let buttons = graph.query(&EntityKind::Button, None);
        assert_eq!(buttons.len(), 1);
    }

    #[test]
    fn query_with_property_filter() {
        let mut graph = StateGraph::new();
        graph.upsert(make_entity(
            EntityKind::TableRow,
            "r1",
            json!({"status": "Unpaid", "amount": 5000}),
        ));
        graph.upsert(make_entity(
            EntityKind::TableRow,
            "r2",
            json!({"status": "Unpaid", "amount": 15000}),
        ));
        graph.upsert(make_entity(
            EntityKind::TableRow,
            "r3",
            json!({"status": "Paid", "amount": 20000}),
        ));

        let unpaid_large = graph.query(
            &EntityKind::TableRow,
            Some(&|e: &SemanticEntity| {
                e.properties.get("status").and_then(|v| v.as_str()) == Some("Unpaid")
                    && e.properties
                        .get("amount")
                        .and_then(|v| v.as_f64())
                        .unwrap_or(0.0)
                        > 10000.0
            }),
        );

        assert_eq!(unpaid_large.len(), 1);
        assert_eq!(unpaid_large[0].properties["amount"], 15000);
    }

    #[test]
    fn remove_hides_entity_from_queries() {
        let mut graph = StateGraph::new();
        let id = graph.upsert(make_entity(EntityKind::Table, "t1", json!({})));
        graph.remove(id);

        assert_eq!(graph.entity_count(), 0);
        assert!(graph.get(id).unwrap().status == EntityStatus::Removed);
        assert!(graph.query(&EntityKind::Table, None).is_empty());
    }

    #[test]
    fn invalidation_propagates_to_dependents() {
        let mut graph = StateGraph::new();
        let table_id = graph.upsert(make_entity(EntityKind::Table, "t1", json!({})));
        let row1_id = graph.upsert(make_entity(EntityKind::TableRow, "r1", json!({})));
        let row2_id = graph.upsert(make_entity(EntityKind::TableRow, "r2", json!({})));

        // rows depend on the table
        graph.add_relation(row1_id, table_id, Relation::DependsOn);
        graph.add_relation(row2_id, table_id, Relation::DependsOn);

        let invalidated = graph.invalidate(table_id);

        assert_eq!(invalidated.len(), 3);
        assert_eq!(graph.get(table_id).unwrap().status, EntityStatus::Stale);
        assert_eq!(graph.get(row1_id).unwrap().status, EntityStatus::Stale);
        assert_eq!(graph.get(row2_id).unwrap().status, EntityStatus::Stale);
    }

    #[test]
    fn stable_key_reconciliation() {
        let mut graph = StateGraph::new();
        let key = StableKey::new(EntityKind::Table, "invoices");

        let entity1 = make_entity(EntityKind::Table, "invoices", json!({"v": 1}));
        let id1 = graph.upsert(entity1);

        // Simulate a rerender — same stable key, new properties
        let entity2 = make_entity(EntityKind::Table, "invoices", json!({"v": 2}));
        let id2 = graph.upsert(entity2);

        assert_eq!(id1, id2);
        assert_eq!(graph.resolve_key(&key), Some(id1));
        assert_eq!(graph.get(id1).unwrap().properties["v"], 2);
    }

    #[test]
    fn gc_removes_dead_entities() {
        let mut graph = StateGraph::new();
        let id = graph.upsert(make_entity(EntityKind::Table, "t1", json!({})));
        graph.upsert(make_entity(EntityKind::Table, "t2", json!({})));
        graph.remove(id);

        graph.gc();

        assert_eq!(graph.entity_count(), 1);
        assert!(graph.get(id).is_none());
    }
}
