use petgraph::graph::NodeIndex;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Internal graph node identifier. Wraps petgraph's NodeIndex for type safety.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct EntityId(pub u32);

impl EntityId {
    pub fn from_node_index(idx: NodeIndex) -> Self {
        Self(idx.index() as u32)
    }

    pub fn to_node_index(self) -> NodeIndex {
        NodeIndex::new(self.0 as usize)
    }
}

/// Content-addressed identity that survives DOM rerenders.
/// Built from entity kind + structural fingerprint + semantic labels.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct StableKey {
    pub kind: EntityKind,
    pub fingerprint: String,
}

impl StableKey {
    pub fn new(kind: EntityKind, fingerprint: impl Into<String>) -> Self {
        Self {
            kind,
            fingerprint: fingerprint.into(),
        }
    }
}

/// Classification of semantic entities extracted from the page.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EntityKind {
    Table,
    TableRow,
    Form,
    FormField,
    Button,
    Link,
    Modal,
    Dialog,
    Menu,
    Tab,
    List,
    ListItem,
    SearchResult,
    Pagination,
    Custom(String),
}

/// Lifecycle status of an entity in the state graph.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EntityStatus {
    Fresh,
    Stale,
    Removed,
}

/// A reference back to the DOM source of an extracted entity.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceRef {
    pub selector: String,
    pub backend_node_id: Option<i64>,
    pub a11y_id: Option<String>,
}

/// A semantic entity extracted from browser state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SemanticEntity {
    pub id: EntityId,
    pub stable_key: StableKey,
    pub kind: EntityKind,
    pub properties: serde_json::Value,
    pub source: SourceRef,
    pub confidence: f64,
    pub version: u64,
    pub status: EntityStatus,
    pub session_entity_id: String,
}

impl SemanticEntity {
    pub fn new(
        id: EntityId,
        stable_key: StableKey,
        kind: EntityKind,
        properties: serde_json::Value,
        source: SourceRef,
        confidence: f64,
    ) -> Self {
        Self {
            id,
            stable_key,
            kind: kind.clone(),
            properties,
            source,
            confidence,
            version: 1,
            status: EntityStatus::Fresh,
            session_entity_id: Uuid::new_v4().to_string(),
        }
    }

    pub fn mark_stale(&mut self) {
        self.status = EntityStatus::Stale;
    }

    pub fn mark_removed(&mut self) {
        self.status = EntityStatus::Removed;
    }

    pub fn bump_version(&mut self) {
        self.version += 1;
        self.status = EntityStatus::Fresh;
    }
}

/// Edge types in the state graph.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Relation {
    ChildOf,
    ContainedIn,
    DependsOn,
    DerivedFrom,
}
