#[cfg(test)]
mod tests {
    use gs_types::*;
    use serde_json::json;

    use crate::Tracer;

    #[test]
    fn navigation_event_recorded_with_url_and_status() {
        let tracer = Tracer::new("sess");
        tracer.record_navigation("https://example.com/page", Some(200));

        let events = tracer.events();
        assert_eq!(events.len(), 1);
        match &events[0] {
            TraceEvent::Navigation {
                url, status, seq, ..
            } => {
                assert_eq!(url, "https://example.com/page");
                assert_eq!(*status, Some(200));
                assert_eq!(*seq, 1);
            }
            other => panic!("expected Navigation, got {other:?}"),
        }
    }

    #[test]
    fn extraction_event_recorded_with_entity_type_and_count() {
        let tracer = Tracer::new("sess");
        tracer.record_extraction("Table", 5, 120);

        let events = tracer.events();
        assert_eq!(events.len(), 1);
        match &events[0] {
            TraceEvent::Extraction {
                entity_type,
                count,
                duration_ms,
                seq,
                ..
            } => {
                assert_eq!(entity_type, "Table");
                assert_eq!(*count, 5);
                assert_eq!(*duration_ms, 120);
                assert_eq!(*seq, 1);
            }
            other => panic!("expected Extraction, got {other:?}"),
        }
    }

    #[test]
    fn snapshot_event_records_hash_and_diff_counts() {
        let tracer = Tracer::new("sess");
        tracer.record_snapshot(
            "refresh",
            "https://example.com",
            "abc123",
            Some("prev999".into()),
            true,
            3,
            1,
            10,
        );

        let events = tracer.events();
        assert_eq!(events.len(), 1);
        match &events[0] {
            TraceEvent::Snapshot {
                label,
                url,
                snapshot_hash,
                previous_snapshot_hash,
                changed,
                added_count,
                removed_count,
                entity_count,
                seq,
                ..
            } => {
                assert_eq!(label, "refresh");
                assert_eq!(url, "https://example.com");
                assert_eq!(snapshot_hash, "abc123");
                assert_eq!(previous_snapshot_hash.as_deref(), Some("prev999"));
                assert!(*changed);
                assert_eq!(*added_count, 3);
                assert_eq!(*removed_count, 1);
                assert_eq!(*entity_count, 10);
                assert_eq!(*seq, 1);
            }
            other => panic!("expected Snapshot, got {other:?}"),
        }
    }

    #[test]
    fn execution_event_recorded_with_step_and_result() {
        let tracer = Tracer::new("sess");

        let step = ExecutionStep {
            id: "step-1".into(),
            action: Action {
                id: ActionId::new(),
                name: "Click button".into(),
                action_type: ActionType::Click,
                targets: vec![EntityId(0)],
                target_ref: TargetRef::Selector {
                    selector: "#btn".into(),
                },
                preconditions: vec![],
                postconditions: vec![],
                confidence: 0.9,
                params: None,
            },
            params: None,
            description: "click the submit button".into(),
        };

        let result = ExecutionResult {
            step_id: "step-1".into(),
            status: ExecutionStatus::Success,
            postconditions: vec![],
            duration_ms: 50,
            error: None,
        };

        tracer.record_execution(step, result);

        let events = tracer.events();
        assert_eq!(events.len(), 1);
        match &events[0] {
            TraceEvent::Execution {
                step, result, seq, ..
            } => {
                assert_eq!(step.id, "step-1");
                assert_eq!(result.status, ExecutionStatus::Success);
                assert_eq!(*seq, 1);
            }
            other => panic!("expected Execution, got {other:?}"),
        }
    }

    #[test]
    fn error_event_recorded_with_code_and_context() {
        let tracer = Tracer::new("sess");
        tracer.record_error(
            "TIMEOUT",
            "page load exceeded 30s",
            Some(json!({"url": "https://slow.com"})),
        );

        let events = tracer.events();
        assert_eq!(events.len(), 1);
        match &events[0] {
            TraceEvent::Error {
                code,
                message,
                context,
                seq,
                ..
            } => {
                assert_eq!(code, "TIMEOUT");
                assert_eq!(message, "page load exceeded 30s");
                assert_eq!(context.as_ref().unwrap()["url"], "https://slow.com");
                assert_eq!(*seq, 1);
            }
            other => panic!("expected Error, got {other:?}"),
        }
    }

    #[test]
    fn events_maintain_strict_monotonic_ordering_under_concurrent_writes() {
        let tracer = Tracer::new("concurrent");
        let handles: Vec<_> = (0..50)
            .map(|i| {
                let t = tracer.clone();
                std::thread::spawn(move || {
                    t.record_navigation(format!("https://page-{i}.com"), Some(200));
                })
            })
            .collect();

        for h in handles {
            h.join().unwrap();
        }

        let events = tracer.events();
        assert_eq!(events.len(), 50);

        // All sequence numbers must be unique
        let mut seqs: Vec<u64> = events.iter().map(|e| e.seq()).collect();
        seqs.sort();
        for window in seqs.windows(2) {
            assert!(
                window[1] > window[0],
                "sequence numbers must be strictly monotonic: {} vs {}",
                window[0],
                window[1]
            );
        }

        // Sequence numbers must be 1..=50
        assert_eq!(*seqs.first().unwrap(), 1);
        assert_eq!(*seqs.last().unwrap(), 50);
    }

    #[test]
    fn events_since_returns_correct_subset() {
        let tracer = Tracer::new("sess");
        tracer.record_navigation("https://a.com", None);
        tracer.record_extraction("Table", 2, 30);
        tracer.record_error("ERR", "something", None);
        tracer.record_navigation("https://b.com", Some(301));

        // events_since(2) should return seq 3 and 4
        let subset = tracer.events_since(2);
        assert_eq!(subset.len(), 2);
        assert_eq!(subset[0].seq(), 3);
        assert_eq!(subset[1].seq(), 4);

        // events_since(0) should return all
        let all = tracer.events_since(0);
        assert_eq!(all.len(), 4);

        // events_since(4) should return nothing
        let empty = tracer.events_since(4);
        assert!(empty.is_empty());
    }

    #[test]
    fn to_trace_data_includes_all_events_and_correct_duration() {
        let tracer = Tracer::new("sess-456");
        tracer.record_navigation("https://a.com", Some(200));
        tracer.record_extraction("Button", 3, 10);
        tracer.record_error("FAIL", "oops", None);

        let data = tracer.to_trace_data();
        assert_eq!(data.session_id, "sess-456");
        assert_eq!(data.entries.len(), 3);
        assert!(
            data.duration_ms < 5000,
            "duration should be near-instant in tests"
        );
        assert!(data.started_at <= chrono::Utc::now());
    }

    #[test]
    fn empty_trace_produces_valid_trace_data() {
        let tracer = Tracer::new("empty-sess");
        let data = tracer.to_trace_data();

        assert_eq!(data.session_id, "empty-sess");
        assert!(data.entries.is_empty());
        assert!(data.duration_ms < 1000);
        assert!(data.started_at <= chrono::Utc::now());

        // Should serialize to valid JSON
        let json_str = tracer.to_json();
        let parsed: serde_json::Value = serde_json::from_str(&json_str).unwrap();
        assert_eq!(parsed["session_id"], "empty-sess");
        assert!(parsed["entries"].as_array().unwrap().is_empty());
    }
}
