use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::{ExecutionResult, ExecutionStep};

/// A single entry in the execution trace.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TraceEvent {
    Navigation {
        url: String,
        status: Option<i32>,
        timestamp: DateTime<Utc>,
        seq: u64,
    },
    Extraction {
        entity_type: String,
        count: usize,
        duration_ms: u64,
        timestamp: DateTime<Utc>,
        seq: u64,
    },
    Query {
        entity_type: String,
        filter: Option<serde_json::Value>,
        result_count: usize,
        duration_ms: u64,
        timestamp: DateTime<Utc>,
        seq: u64,
    },
    Execution {
        step: Box<ExecutionStep>,
        result: ExecutionResult,
        timestamp: DateTime<Utc>,
        seq: u64,
    },
    StateChange {
        description: String,
        invalidated_count: usize,
        timestamp: DateTime<Utc>,
        seq: u64,
    },
    Error {
        code: String,
        message: String,
        context: Option<serde_json::Value>,
        timestamp: DateTime<Utc>,
        seq: u64,
    },
    Observation {
        url: String,
        entity_count: usize,
        duration_ms: u64,
        timestamp: DateTime<Utc>,
        seq: u64,
    },
    Snapshot {
        label: String,
        url: String,
        snapshot_hash: String,
        previous_snapshot_hash: Option<String>,
        changed: bool,
        added_count: usize,
        removed_count: usize,
        entity_count: usize,
        timestamp: DateTime<Utc>,
        seq: u64,
    },
}

impl TraceEvent {
    pub fn seq(&self) -> u64 {
        match self {
            Self::Navigation { seq, .. }
            | Self::Extraction { seq, .. }
            | Self::Query { seq, .. }
            | Self::Execution { seq, .. }
            | Self::StateChange { seq, .. }
            | Self::Error { seq, .. }
            | Self::Observation { seq, .. }
            | Self::Snapshot { seq, .. } => *seq,
        }
    }

    pub fn timestamp(&self) -> DateTime<Utc> {
        match self {
            Self::Navigation { timestamp, .. }
            | Self::Extraction { timestamp, .. }
            | Self::Query { timestamp, .. }
            | Self::Execution { timestamp, .. }
            | Self::StateChange { timestamp, .. }
            | Self::Error { timestamp, .. }
            | Self::Observation { timestamp, .. }
            | Self::Snapshot { timestamp, .. } => *timestamp,
        }
    }
}

/// Serialized trace for a complete session.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TraceData {
    pub session_id: String,
    pub started_at: DateTime<Utc>,
    pub entries: Vec<TraceEvent>,
    pub duration_ms: u64,
}
