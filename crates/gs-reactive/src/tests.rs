use crate::ReactiveConfig;

#[test]
fn default_config_values() {
    let config = ReactiveConfig::default();
    assert_eq!(config.debounce_ms, 300);
    assert_eq!(config.max_debounce_ms, 2000);
    assert!(config.observe_on_navigate);
}

#[test]
fn config_deserializes_with_defaults() {
    let json = r#"{"debounce_ms": 100}"#;
    let config: ReactiveConfig = serde_json::from_str(json).unwrap();
    assert_eq!(config.debounce_ms, 100);
    assert_eq!(config.max_debounce_ms, 2000); // default
    assert!(config.observe_on_navigate); // default
}

#[test]
fn config_deserializes_full() {
    let json = r#"{"debounce_ms": 100, "max_debounce_ms": 500, "observe_on_navigate": false}"#;
    let config: ReactiveConfig = serde_json::from_str(json).unwrap();
    assert_eq!(config.debounce_ms, 100);
    assert_eq!(config.max_debounce_ms, 500);
    assert!(!config.observe_on_navigate);
}
