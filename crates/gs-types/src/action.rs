use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{Condition, EntityId};

/// Unique identifier for an action.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ActionId(pub String);

impl ActionId {
    pub fn new() -> Self {
        Self(Uuid::new_v4().to_string())
    }
}

impl Default for ActionId {
    fn default() -> Self {
        Self::new()
    }
}

/// Classification of the browser interaction an action performs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionType {
    Click,
    Fill,
    Select,
    Hover,
    Keyboard,
    Navigate,
    Composite,
}

/// How to locate the target element for execution.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TargetRef {
    Selector { selector: String },
    EntityId { entity_id: EntityId },
    BackendNodeId { id: i64 },
}

/// A first-class executable action derived from browser state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Action {
    pub id: ActionId,
    pub name: String,
    pub action_type: ActionType,
    pub targets: Vec<EntityId>,
    pub target_ref: TargetRef,
    pub preconditions: Vec<Condition>,
    pub postconditions: Vec<Condition>,
    pub confidence: f64,
    pub params: Option<serde_json::Value>,
}

/// A step in an execution plan.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionStep {
    pub id: String,
    pub action: Action,
    pub params: Option<serde_json::Value>,
    pub description: String,
}

/// Outcome of executing a single step.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionResult {
    pub step_id: String,
    pub status: ExecutionStatus,
    pub postconditions: Vec<crate::ConditionResult>,
    pub duration_ms: u64,
    pub error: Option<ExecutionError>,
}

/// Whether an execution succeeded, failed, or was skipped.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionStatus {
    Success,
    Failed,
    Skipped,
}

/// Structured error from a failed execution.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionError {
    pub code: String,
    pub message: String,
    pub recoverable: bool,
}
