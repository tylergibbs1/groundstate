use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use gs_types::*;
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio::sync::{Mutex, broadcast, oneshot};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

use crate::{BrowserTransport, TransportError};

type WsStream = WebSocketStream<MaybeTlsStream<TcpStream>>;
type PendingRequests = Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>;

/// Chrome DevTools Protocol transport over WebSocket.
///
/// Connects to a Chrome instance's debugging endpoint, sends JSON-RPC
/// commands, and receives events. A background task reads from the
/// WebSocket and dispatches responses to waiting callers via oneshot
/// channels, and broadcasts events to subscribers.
pub struct CdpTransport {
    ws_url: String,
    write: Option<Arc<Mutex<futures_util::stream::SplitSink<WsStream, Message>>>>,
    pending: PendingRequests,
    next_id: Arc<AtomicU64>,
    event_tx: broadcast::Sender<BrowserEvent>,
    current_url: Arc<Mutex<String>>,
}

impl CdpTransport {
    /// Create a new CDP transport targeting the given WebSocket debugger URL.
    ///
    /// The URL is typically obtained from Chrome's `/json/version` endpoint,
    /// e.g. `ws://127.0.0.1:9222/devtools/browser/...`
    pub fn new(ws_url: impl Into<String>) -> Self {
        let (event_tx, _) = broadcast::channel(256);
        Self {
            ws_url: ws_url.into(),
            write: None,
            pending: Arc::new(Mutex::new(HashMap::new())),
            next_id: Arc::new(AtomicU64::new(1)),
            event_tx,
            current_url: Arc::new(Mutex::new(String::new())),
        }
    }

    /// Send a CDP command and wait for the response.
    async fn send_command(&self, method: &str, params: Value) -> Result<Value, TransportError> {
        let write = self.write.as_ref().ok_or(TransportError::NotConnected)?;

        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let msg = json!({
            "id": id,
            "method": method,
            "params": params,
        });

        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);

        write
            .lock()
            .await
            .send(Message::Text(msg.to_string().into()))
            .await
            .map_err(|e| TransportError::WebSocket(e.to_string()))?;

        let response = tokio::time::timeout(std::time::Duration::from_secs(30), rx)
            .await
            .map_err(|_| TransportError::Timeout(30000))?
            .map_err(|_| TransportError::WebSocket("response channel dropped".into()))?;

        if let Some(error) = response.get("error") {
            return Err(TransportError::CdpError {
                method: method.to_string(),
                message: error
                    .get("message")
                    .and_then(|m| m.as_str())
                    .unwrap_or("unknown")
                    .to_string(),
            });
        }

        Ok(response.get("result").cloned().unwrap_or(Value::Null))
    }

    /// Parse a CDP DOM node into our DomNode type.
    fn parse_dom_node(node: &Value) -> DomNode {
        let children = node
            .get("children")
            .and_then(|c| c.as_array())
            .map(|arr| arr.iter().map(Self::parse_dom_node).collect())
            .unwrap_or_default();

        let attributes = node
            .get("attributes")
            .and_then(|a| a.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();

        DomNode {
            node_id: node["nodeId"].as_i64().unwrap_or(0),
            backend_node_id: node["backendNodeId"].as_i64().unwrap_or(0),
            node_type: node["nodeType"].as_i64().unwrap_or(0) as i32,
            node_name: node["nodeName"].as_str().unwrap_or("").to_string(),
            node_value: node["nodeValue"].as_str().unwrap_or("").to_string(),
            attributes,
            children,
        }
    }

    /// Resolve a TargetRef to a CDP-compatible selector or node ID.
    async fn resolve_target(&self, target: &TargetRef) -> Result<ResolvedTarget, TransportError> {
        match target {
            TargetRef::Selector { selector } => {
                // Use DOM.querySelector to resolve the selector
                let result = self
                    .send_command("DOM.getDocument", json!({"depth": 0}))
                    .await?;

                let root_id = result["root"]["nodeId"]
                    .as_i64()
                    .ok_or_else(|| TransportError::ElementNotFound("no root node".into()))?;

                let result = self
                    .send_command(
                        "DOM.querySelector",
                        json!({"nodeId": root_id, "selector": selector}),
                    )
                    .await?;

                let node_id = result["nodeId"]
                    .as_i64()
                    .filter(|&id| id > 0)
                    .ok_or_else(|| {
                        TransportError::ElementNotFound(format!("selector not found: {selector}"))
                    })?;

                Ok(ResolvedTarget::NodeId(node_id))
            }
            TargetRef::BackendNodeId { id } => Ok(ResolvedTarget::BackendNodeId(*id)),
            TargetRef::EntityId { .. } => Err(TransportError::ElementNotFound(
                "EntityId must be resolved to a selector before transport dispatch".into(),
            )),
        }
    }

    /// Get the box model for a node, then compute the center point for clicking.
    async fn get_click_point(
        &self,
        resolved: &ResolvedTarget,
    ) -> Result<(f64, f64), TransportError> {
        let params = match resolved {
            ResolvedTarget::NodeId(id) => json!({"nodeId": id}),
            ResolvedTarget::BackendNodeId(id) => json!({"backendNodeId": id}),
        };

        let result = self.send_command("DOM.getBoxModel", params).await?;

        let content = result["model"]["content"]
            .as_array()
            .ok_or_else(|| TransportError::ElementNotFound("no box model".into()))?;

        // content quad is [x1,y1, x2,y2, x3,y3, x4,y4]
        if content.len() < 8 {
            return Err(TransportError::ElementNotFound("invalid box model".into()));
        }

        let x = (content[0].as_f64().unwrap_or(0.0) + content[4].as_f64().unwrap_or(0.0)) / 2.0;
        let y = (content[1].as_f64().unwrap_or(0.0) + content[5].as_f64().unwrap_or(0.0)) / 2.0;

        Ok((x, y))
    }
}

enum ResolvedTarget {
    NodeId(i64),
    BackendNodeId(i64),
}

#[async_trait]
impl BrowserTransport for CdpTransport {
    async fn connect(&mut self) -> Result<(), TransportError> {
        let (ws_stream, _) = tokio_tungstenite::connect_async(&self.ws_url)
            .await
            .map_err(|e| TransportError::ConnectionFailed(e.to_string()))?;

        let (write, read) = ws_stream.split();
        self.write = Some(Arc::new(Mutex::new(write)));

        // Spawn background reader
        let pending = self.pending.clone();
        let event_tx = self.event_tx.clone();
        let current_url = self.current_url.clone();

        tokio::spawn(async move {
            let mut read = read;
            while let Some(msg) = read.next().await {
                let msg = match msg {
                    Ok(Message::Text(t)) => t.to_string(),
                    Ok(_) => continue,
                    Err(_) => break,
                };

                let parsed: Value = match serde_json::from_str(&msg) {
                    Ok(v) => v,
                    Err(_) => continue,
                };

                // Response to a command
                if let Some(id) = parsed.get("id").and_then(|v| v.as_u64()) {
                    if let Some(tx) = pending.lock().await.remove(&id) {
                        let _ = tx.send(parsed);
                    }
                    continue;
                }

                // CDP event
                if let Some(method) = parsed.get("method").and_then(|v| v.as_str()) {
                    let params = parsed.get("params").cloned().unwrap_or(Value::Null);

                    let event = match method {
                        "DOM.documentUpdated" => Some(BrowserEvent::DomMutation {
                            description: "document updated".into(),
                        }),
                        "Page.frameNavigated" => {
                            let url = params["frame"]["url"].as_str().unwrap_or("").to_string();
                            let frame_id = params["frame"]["id"].as_str().unwrap_or("").to_string();
                            *current_url.lock().await = url.clone();
                            Some(BrowserEvent::FrameNavigated { frame_id, url })
                        }
                        "Page.loadEventFired" => {
                            let url = current_url.lock().await.clone();
                            Some(BrowserEvent::LoadComplete { url })
                        }
                        "Network.requestWillBeSent" => Some(BrowserEvent::NetworkRequest {
                            request_id: params["requestId"].as_str().unwrap_or("").to_string(),
                            url: params["request"]["url"].as_str().unwrap_or("").to_string(),
                            method: params["request"]["method"]
                                .as_str()
                                .unwrap_or("")
                                .to_string(),
                        }),
                        "Network.responseReceived" => Some(BrowserEvent::NetworkResponse {
                            request_id: params["requestId"].as_str().unwrap_or("").to_string(),
                            status: params["response"]["status"].as_i64().unwrap_or(0) as i32,
                            url: params["response"]["url"].as_str().unwrap_or("").to_string(),
                        }),
                        "Page.javascriptDialogOpening" => Some(BrowserEvent::DialogOpened {
                            dialog_type: params["type"].as_str().unwrap_or("").to_string(),
                            message: params["message"].as_str().unwrap_or("").to_string(),
                        }),
                        _ => None,
                    };

                    if let Some(event) = event {
                        let _ = event_tx.send(event);
                    }
                }
            }
        });

        // Enable required CDP domains
        self.send_command("Page.enable", json!({})).await?;
        self.send_command("DOM.enable", json!({})).await?;
        self.send_command("Network.enable", json!({})).await?;
        self.send_command("Runtime.enable", json!({})).await?;

        Ok(())
    }

    async fn disconnect(&mut self) -> Result<(), TransportError> {
        if let Some(write) = self.write.take() {
            let mut w = write.lock().await;
            let _ = w.close().await;
        }
        Ok(())
    }

    async fn navigate(&mut self, url: &str) -> Result<NavigationResult, TransportError> {
        let result = self
            .send_command("Page.navigate", json!({"url": url}))
            .await?;

        if let Some(error) = result.get("errorText").and_then(|e| e.as_str()) {
            return Err(TransportError::NavigationFailed(error.to_string()));
        }

        let frame_id = result["frameId"].as_str().unwrap_or("").to_string();
        let loader_id = result["loaderId"].as_str().map(String::from);

        // Wait for load event
        let mut rx = self.event_tx.subscribe();
        tokio::time::timeout(std::time::Duration::from_secs(30), async {
            while let Ok(event) = rx.recv().await {
                if matches!(event, BrowserEvent::LoadComplete { .. }) {
                    return Ok(());
                }
            }
            Err(TransportError::Timeout(30000))
        })
        .await
        .map_err(|_| TransportError::Timeout(30000))??;

        *self.current_url.lock().await = url.to_string();

        Ok(NavigationResult {
            url: url.to_string(),
            frame_id,
            loader_id,
        })
    }

    async fn get_dom(&mut self) -> Result<DomSnapshot, TransportError> {
        let result = self
            .send_command("DOM.getDocument", json!({"depth": -1, "pierce": true}))
            .await?;

        let root = result.get("root").ok_or_else(|| TransportError::CdpError {
            method: "DOM.getDocument".into(),
            message: "no root in response".into(),
        })?;

        Ok(DomSnapshot {
            root: Self::parse_dom_node(root),
        })
    }

    async fn get_accessibility_tree(&mut self) -> Result<A11ySnapshot, TransportError> {
        // Enable and fetch
        let _ = self.send_command("Accessibility.enable", json!({})).await;

        let result = self
            .send_command("Accessibility.getFullAXTree", json!({}))
            .await?;

        let nodes = result
            .get("nodes")
            .and_then(|n| n.as_array())
            .map(|arr| {
                arr.iter()
                    .map(|node| {
                        let properties = node
                            .get("properties")
                            .and_then(|p| p.as_array())
                            .map(|props| {
                                props
                                    .iter()
                                    .map(|p| A11yProperty {
                                        name: p["name"].as_str().unwrap_or("").to_string(),
                                        value: p["value"]["value"].clone(),
                                    })
                                    .collect()
                            })
                            .unwrap_or_default();

                        A11yNode {
                            node_id: node["nodeId"].as_str().unwrap_or("").to_string(),
                            role: node["role"]["value"].as_str().unwrap_or("").to_string(),
                            name: node["name"]["value"].as_str().map(String::from),
                            value: node["value"]["value"].as_str().map(String::from),
                            backend_dom_node_id: node["backendDOMNodeId"].as_i64(),
                            children: node
                                .get("childIds")
                                .and_then(|c| c.as_array())
                                .map(|arr| {
                                    arr.iter()
                                        .filter_map(|v| v.as_str().map(String::from))
                                        .collect()
                                })
                                .unwrap_or_default(),
                            properties,
                        }
                    })
                    .collect()
            })
            .unwrap_or_default();

        Ok(A11ySnapshot { nodes })
    }

    async fn evaluate_js(&mut self, script: &str) -> Result<serde_json::Value, TransportError> {
        let result = self
            .send_command(
                "Runtime.evaluate",
                json!({
                    "expression": script,
                    "returnByValue": true,
                    "awaitPromise": true,
                }),
            )
            .await?;

        if let Some(exception) = result.get("exceptionDetails") {
            return Err(TransportError::JsEvalError(
                exception["exception"]["description"]
                    .as_str()
                    .unwrap_or("unknown JS error")
                    .to_string(),
            ));
        }

        Ok(result
            .get("result")
            .and_then(|r| r.get("value"))
            .cloned()
            .unwrap_or(Value::Null))
    }

    async fn click(&mut self, target: &TargetRef) -> Result<(), TransportError> {
        let resolved = self.resolve_target(target).await?;
        let (x, y) = self.get_click_point(&resolved).await?;

        // Dispatch mouse events: move, press, release
        self.send_command(
            "Input.dispatchMouseEvent",
            json!({"type": "mouseMoved", "x": x, "y": y}),
        )
        .await?;

        self.send_command(
            "Input.dispatchMouseEvent",
            json!({"type": "mousePressed", "x": x, "y": y, "button": "left", "clickCount": 1}),
        )
        .await?;

        self.send_command(
            "Input.dispatchMouseEvent",
            json!({"type": "mouseReleased", "x": x, "y": y, "button": "left", "clickCount": 1}),
        )
        .await?;

        Ok(())
    }

    async fn type_text(&mut self, target: &TargetRef, text: &str) -> Result<(), TransportError> {
        // Focus the element first
        let resolved = self.resolve_target(target).await?;
        match &resolved {
            ResolvedTarget::NodeId(id) => {
                self.send_command("DOM.focus", json!({"nodeId": id}))
                    .await?;
            }
            ResolvedTarget::BackendNodeId(id) => {
                self.send_command("DOM.focus", json!({"backendNodeId": id}))
                    .await?;
            }
        }

        // Type each character
        for ch in text.chars() {
            self.send_command(
                "Input.dispatchKeyEvent",
                json!({"type": "keyDown", "text": ch.to_string()}),
            )
            .await?;
            self.send_command(
                "Input.dispatchKeyEvent",
                json!({"type": "keyUp", "text": ch.to_string()}),
            )
            .await?;
        }

        Ok(())
    }

    async fn screenshot(&mut self) -> Result<Vec<u8>, TransportError> {
        use base64::Engine;

        let result = self
            .send_command("Page.captureScreenshot", json!({"format": "png"}))
            .await?;

        let data = result["data"]
            .as_str()
            .ok_or_else(|| TransportError::CdpError {
                method: "Page.captureScreenshot".into(),
                message: "no data in response".into(),
            })?;

        base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|e: base64::DecodeError| TransportError::Serialization(e.to_string()))
    }

    fn event_receiver(&self) -> broadcast::Receiver<BrowserEvent> {
        self.event_tx.subscribe()
    }

    async fn current_url(&self) -> Result<String, TransportError> {
        Ok(self.current_url.lock().await.clone())
    }
}
