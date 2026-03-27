pub mod cdp;
mod error;

pub use error::TransportError;

use async_trait::async_trait;
use gs_types::{A11ySnapshot, BrowserEvent, DomSnapshot, NavigationResult, TargetRef};
use tokio::sync::broadcast;

/// Abstraction over browser communication protocols.
///
/// The runtime operates through this trait. CDP is the default implementation.
/// A Playwright adapter can be added later without changing the core.
#[async_trait]
pub trait BrowserTransport: Send + Sync {
    /// Establish a connection to the browser.
    async fn connect(&mut self) -> Result<(), TransportError>;

    /// Disconnect from the browser.
    async fn disconnect(&mut self) -> Result<(), TransportError>;

    /// Navigate to a URL and wait for the page to load.
    async fn navigate(&mut self, url: &str) -> Result<NavigationResult, TransportError>;

    /// Capture the current DOM tree.
    async fn get_dom(&mut self) -> Result<DomSnapshot, TransportError>;

    /// Capture the accessibility tree.
    async fn get_accessibility_tree(&mut self) -> Result<A11ySnapshot, TransportError>;

    /// Evaluate JavaScript in the page context.
    async fn evaluate_js(&mut self, script: &str) -> Result<serde_json::Value, TransportError>;

    /// Click an element.
    async fn click(&mut self, target: &TargetRef) -> Result<(), TransportError>;

    /// Type text into an element.
    async fn type_text(&mut self, target: &TargetRef, text: &str) -> Result<(), TransportError>;

    /// Capture a screenshot as PNG bytes.
    async fn screenshot(&mut self) -> Result<Vec<u8>, TransportError>;

    /// Subscribe to browser events (DOM mutations, navigations, etc.).
    fn event_receiver(&self) -> broadcast::Receiver<BrowserEvent>;

    /// Get the current page URL.
    async fn current_url(&self) -> Result<String, TransportError>;
}
