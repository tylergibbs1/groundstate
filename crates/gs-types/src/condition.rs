use serde::{Deserialize, Serialize};

use crate::EntityId;

/// A named condition with a machine-checkable definition.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Condition {
    pub description: String,
    pub check: ConditionCheck,
}

/// The specific check to evaluate for a condition.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ConditionCheck {
    ElementVisible {
        selector: String,
    },
    ElementAbsent {
        selector: String,
    },
    TextMatches {
        selector: String,
        pattern: String,
    },
    UrlMatches {
        pattern: String,
    },
    EntityState {
        entity_id: EntityId,
        field: String,
        expected: serde_json::Value,
    },
}

/// Result of evaluating a single condition.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConditionResult {
    pub condition: Condition,
    pub passed: bool,
    pub actual: Option<serde_json::Value>,
    pub message: Option<String>,
}
