use chrono::Utc;
use gs_transport::{BrowserTransport, TransportError};
use gs_types::{BrowserEvent, RawObservation};

/// Captures structured observations from the browser via the transport layer.
pub struct Observer {
    /// How long to wait (ms) after the last DOM mutation before considering the page stable.
    settle_delay_ms: u64,
}

impl Default for Observer {
    fn default() -> Self {
        Self::new()
    }
}

impl Observer {
    pub fn new() -> Self {
        Self {
            settle_delay_ms: 500,
        }
    }

    pub fn with_settle_delay(mut self, ms: u64) -> Self {
        self.settle_delay_ms = ms;
        self
    }

    /// Take a full snapshot of the current page state.
    pub async fn observe(
        &self,
        transport: &mut dyn BrowserTransport,
    ) -> Result<RawObservation, TransportError> {
        let dom = transport.get_dom().await?;
        let a11y = transport.get_accessibility_tree().await.ok();
        let url = transport.current_url().await.unwrap_or_default();
        let title = transport
            .evaluate_js("document.title")
            .await
            .ok()
            .and_then(|v| v.as_str().map(String::from))
            .unwrap_or_default();

        Ok(RawObservation {
            dom,
            a11y,
            url,
            title,
            timestamp: Utc::now(),
        })
    }

    /// Wait until the page DOM settles (no mutations for `settle_delay_ms`).
    /// Returns early if the timeout is reached.
    pub async fn wait_for_stable(
        &self,
        transport: &dyn BrowserTransport,
        timeout_ms: u64,
    ) -> Result<(), TransportError> {
        let mut rx = transport.event_receiver();
        let settle = std::time::Duration::from_millis(self.settle_delay_ms);
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);

        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return Ok(()); // Timeout — treat as settled
            }

            match tokio::time::timeout(settle.min(remaining), rx.recv()).await {
                // Got a DOM mutation — reset the settle timer
                Ok(Ok(BrowserEvent::DomMutation { .. })) => continue,
                // Got some other event — ignore, keep waiting
                Ok(Ok(_)) => continue,
                // Channel closed
                Ok(Err(_)) => return Ok(()),
                // Timeout expired without any event — page is stable
                Err(_) => return Ok(()),
            }
        }
    }
}
