#[cfg(test)]
mod trace_tests;

use std::sync::{Arc, RwLock};

use chrono::Utc;
use gs_types::{ExecutionResult, ExecutionStep, TraceData, TraceEvent};

/// Append-only execution trace for a browser session.
///
/// Thread-safe via `Arc<RwLock<>>`. Events are assigned monotonically
/// increasing sequence numbers.
#[derive(Clone)]
pub struct Tracer {
    inner: Arc<RwLock<TracerInner>>,
    session_id: String,
}

struct TracerInner {
    events: Vec<TraceEvent>,
    next_seq: u64,
    started_at: chrono::DateTime<Utc>,
}

impl Tracer {
    pub fn new(session_id: impl Into<String>) -> Self {
        Self {
            inner: Arc::new(RwLock::new(TracerInner {
                events: Vec::new(),
                next_seq: 1,
                started_at: Utc::now(),
            })),
            session_id: session_id.into(),
        }
    }

    /// Record a navigation event.
    pub fn record_navigation(&self, url: impl Into<String>, status: Option<i32>) {
        let mut inner = self.inner.write().unwrap();
        let seq = inner.next_seq;
        inner.next_seq += 1;
        inner.events.push(TraceEvent::Navigation {
            url: url.into(),
            status,
            timestamp: Utc::now(),
            seq,
        });
    }

    /// Record an extraction event.
    pub fn record_extraction(&self, entity_type: impl Into<String>, count: usize, duration_ms: u64) {
        let mut inner = self.inner.write().unwrap();
        let seq = inner.next_seq;
        inner.next_seq += 1;
        inner.events.push(TraceEvent::Extraction {
            entity_type: entity_type.into(),
            count,
            duration_ms,
            timestamp: Utc::now(),
            seq,
        });
    }

    /// Record a query event.
    pub fn record_query(
        &self,
        entity_type: impl Into<String>,
        filter: Option<serde_json::Value>,
        result_count: usize,
        duration_ms: u64,
    ) {
        let mut inner = self.inner.write().unwrap();
        let seq = inner.next_seq;
        inner.next_seq += 1;
        inner.events.push(TraceEvent::Query {
            entity_type: entity_type.into(),
            filter,
            result_count,
            duration_ms,
            timestamp: Utc::now(),
            seq,
        });
    }

    /// Record an execution event.
    pub fn record_execution(&self, step: ExecutionStep, result: ExecutionResult) {
        let mut inner = self.inner.write().unwrap();
        let seq = inner.next_seq;
        inner.next_seq += 1;
        inner.events.push(TraceEvent::Execution {
            step: Box::new(step),
            result,
            timestamp: Utc::now(),
            seq,
        });
    }

    /// Record a state change event.
    pub fn record_state_change(&self, description: impl Into<String>, invalidated_count: usize) {
        let mut inner = self.inner.write().unwrap();
        let seq = inner.next_seq;
        inner.next_seq += 1;
        inner.events.push(TraceEvent::StateChange {
            description: description.into(),
            invalidated_count,
            timestamp: Utc::now(),
            seq,
        });
    }

    /// Record an error event.
    pub fn record_error(
        &self,
        code: impl Into<String>,
        message: impl Into<String>,
        context: Option<serde_json::Value>,
    ) {
        let mut inner = self.inner.write().unwrap();
        let seq = inner.next_seq;
        inner.next_seq += 1;
        inner.events.push(TraceEvent::Error {
            code: code.into(),
            message: message.into(),
            context,
            timestamp: Utc::now(),
            seq,
        });
    }

    /// Record an observation event.
    pub fn record_observation(&self, url: impl Into<String>, entity_count: usize, duration_ms: u64) {
        let mut inner = self.inner.write().unwrap();
        let seq = inner.next_seq;
        inner.next_seq += 1;
        inner.events.push(TraceEvent::Observation {
            url: url.into(),
            entity_count,
            duration_ms,
            timestamp: Utc::now(),
            seq,
        });
    }

    /// Record a snapshot/hash event for the current semantic state.
    #[allow(clippy::too_many_arguments)]
    pub fn record_snapshot(
        &self,
        label: impl Into<String>,
        url: impl Into<String>,
        snapshot_hash: impl Into<String>,
        previous_snapshot_hash: Option<String>,
        changed: bool,
        added_count: usize,
        removed_count: usize,
        entity_count: usize,
    ) {
        let mut inner = self.inner.write().unwrap();
        let seq = inner.next_seq;
        inner.next_seq += 1;
        inner.events.push(TraceEvent::Snapshot {
            label: label.into(),
            url: url.into(),
            snapshot_hash: snapshot_hash.into(),
            previous_snapshot_hash,
            changed,
            added_count,
            removed_count,
            entity_count,
            timestamp: Utc::now(),
            seq,
        });
    }

    /// Get all trace events.
    pub fn events(&self) -> Vec<TraceEvent> {
        self.inner.read().unwrap().events.clone()
    }

    /// Get events since a given sequence number (exclusive).
    pub fn events_since(&self, since_seq: u64) -> Vec<TraceEvent> {
        self.inner
            .read()
            .unwrap()
            .events
            .iter()
            .filter(|e| e.seq() > since_seq)
            .cloned()
            .collect()
    }

    /// Get the current sequence number.
    pub fn current_seq(&self) -> u64 {
        self.inner.read().unwrap().next_seq - 1
    }

    /// Serialize the full trace to a TraceData struct.
    pub fn to_trace_data(&self) -> TraceData {
        let inner = self.inner.read().unwrap();
        let now = Utc::now();
        let duration = now - inner.started_at;
        TraceData {
            session_id: self.session_id.clone(),
            started_at: inner.started_at,
            entries: inner.events.clone(),
            duration_ms: duration.num_milliseconds().max(0) as u64,
        }
    }

    /// Serialize to JSON string.
    pub fn to_json(&self) -> String {
        serde_json::to_string(&self.to_trace_data()).unwrap_or_else(|_| "{}".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_events_with_monotonic_sequence() {
        let tracer = Tracer::new("test-session");

        tracer.record_navigation("https://example.com", Some(200));
        tracer.record_extraction("Table", 3, 50);
        tracer.record_error("TIMEOUT", "Page load timeout", None);

        let events = tracer.events();
        assert_eq!(events.len(), 3);
        assert_eq!(events[0].seq(), 1);
        assert_eq!(events[1].seq(), 2);
        assert_eq!(events[2].seq(), 3);
    }

    #[test]
    fn events_since_filters_correctly() {
        let tracer = Tracer::new("test-session");

        tracer.record_navigation("https://a.com", None);
        tracer.record_navigation("https://b.com", None);
        tracer.record_navigation("https://c.com", None);

        let since_1 = tracer.events_since(1);
        assert_eq!(since_1.len(), 2);
        assert_eq!(since_1[0].seq(), 2);
    }

    #[test]
    fn to_trace_data_produces_valid_output() {
        let tracer = Tracer::new("sess-123");
        tracer.record_navigation("https://example.com", Some(200));

        let data = tracer.to_trace_data();
        assert_eq!(data.session_id, "sess-123");
        assert_eq!(data.entries.len(), 1);

        let json = tracer.to_json();
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed["session_id"], "sess-123");
    }

    #[test]
    fn thread_safe_concurrent_writes() {
        let tracer = Tracer::new("concurrent-session");
        let handles: Vec<_> = (0..10)
            .map(|i| {
                let t = tracer.clone();
                std::thread::spawn(move || {
                    t.record_navigation(format!("https://page-{i}.com"), None);
                })
            })
            .collect();

        for h in handles {
            h.join().unwrap();
        }

        assert_eq!(tracer.events().len(), 10);
        // Verify all sequence numbers are unique
        let seqs: Vec<u64> = tracer.events().iter().map(|e| e.seq()).collect();
        let mut sorted = seqs.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), 10);
    }
}
