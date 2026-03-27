use serde::{Deserialize, Serialize};

/// Events emitted by the browser transport.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum BrowserEvent {
    DomMutation {
        description: String,
    },
    Navigation {
        url: String,
        frame_id: String,
    },
    LoadComplete {
        url: String,
    },
    NetworkRequest {
        request_id: String,
        url: String,
        method: String,
    },
    NetworkResponse {
        request_id: String,
        status: i32,
        url: String,
    },
    DialogOpened {
        dialog_type: String,
        message: String,
    },
    FrameNavigated {
        frame_id: String,
        url: String,
    },
}

/// Result of a page navigation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NavigationResult {
    pub url: String,
    pub frame_id: String,
    pub loader_id: Option<String>,
}
