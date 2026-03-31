use gs_types::{EntityId, EntityKind, SemanticEntity};
use serde::Serialize;
use std::sync::mpsc;

/// Unique handle for a graph subscription, used for unsubscribe.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct SubscriptionId(pub(crate) u64);

/// What changed in the graph since the last notification.
#[derive(Debug, Clone, Serialize)]
pub struct GraphDiff {
    pub graph_version: u64,
    pub upserted: Vec<EntitySnapshot>,
    pub invalidated: Vec<EntityId>,
    pub removed: Vec<EntityId>,
}

/// Frozen copy of an entity at a point in time.
#[derive(Debug, Clone, Serialize)]
pub struct EntitySnapshot {
    pub id: EntityId,
    pub kind: EntityKind,
    pub properties: serde_json::Value,
    pub version: u64,
    pub session_entity_id: String,
}

impl From<&SemanticEntity> for EntitySnapshot {
    fn from(e: &SemanticEntity) -> Self {
        // Merge _source and _confidence into properties so the overlay
        // highlight layer can locate elements on the page.
        let mut props = e.properties.clone();
        if let Some(obj) = props.as_object_mut() {
            obj.insert(
                "_source".to_string(),
                serde_json::Value::String(e.source.selector.clone()),
            );
            obj.insert(
                "_confidence".to_string(),
                serde_json::json!(e.confidence),
            );
        }

        Self {
            id: e.id,
            kind: e.kind.clone(),
            properties: props,
            version: e.version,
            session_entity_id: e.session_entity_id.clone(),
        }
    }
}

pub(crate) struct Subscription {
    pub id: SubscriptionId,
    pub kind_filter: Option<EntityKind>,
    pub tx: mpsc::Sender<GraphDiff>,
}

impl Subscription {
    /// Returns true if this subscription matches the given entity kind.
    pub fn matches(&self, kind: &EntityKind) -> bool {
        self.kind_filter.as_ref().is_none_or(|k| k == kind)
    }

    /// Try to send a diff. Returns false if the receiver has been dropped.
    pub fn send(&self, diff: GraphDiff) -> bool {
        self.tx.send(diff).is_ok()
    }
}
