use thiserror::Error;

#[derive(Error, Debug)]
pub enum TransportError {
    #[error("connection failed: {0}")]
    ConnectionFailed(String),

    #[error("not connected")]
    NotConnected,

    #[error("navigation failed: {0}")]
    NavigationFailed(String),

    #[error("CDP protocol error: {method} — {message}")]
    CdpError { method: String, message: String },

    #[error("timeout after {0}ms")]
    Timeout(u64),

    #[error("WebSocket error: {0}")]
    WebSocket(String),

    #[error("serialization error: {0}")]
    Serialization(String),

    #[error("JavaScript evaluation error: {0}")]
    JsEvalError(String),

    #[error("element not found: {0}")]
    ElementNotFound(String),
}
